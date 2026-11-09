import json
import curses
import re
import sys
import argparse
import os
import shutil
from urllib.parse import urlparse, urlunparse
from typing import Any, Dict, List, Optional, Union

# Define fields to censor and their uniform replacement values
CENSOR_MAP = {
    "x-csrf-token": "CENSORED_CSRF",
    "authorization": "CENSORED_AUTH",
    "cookie": "CENSORED_COOKIE",
    "set-cookie": "CENSORED_SET_COOKIE",
    "sap-passport": "CENSORED_SAP_PASSPORT"
}

SENSITIVE_QUERY_KEYS = {"password", "token", "secret", "api_key", "apikey"}


def censor_url_credentials(url: str) -> str:
    """Remove or mask userinfo (username/password) from a URL."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return url

    if parsed.username or parsed.password:
        # netloc without credentials
        netloc = parsed.hostname or ""
        if parsed.port:
            netloc = f"{netloc}:{parsed.port}"
        return urlunparse(parsed._replace(netloc=netloc))
    return url


def censor_data(data: Any) -> Any:
    """Recursively search and censor sensitive tokens in dicts, lists, strings, and embedded JSON/Form data."""
    if isinstance(data, dict):
        new_dict: Dict[str, Any] = {}
        for k, v in data.items():
            k_lower = k.lower()
            if k_lower in CENSOR_MAP:
                new_dict[k] = CENSOR_MAP[k_lower]
            else:
                new_dict[k] = censor_data(v)
        return new_dict

    elif isinstance(data, list):
        return [censor_data(item) for item in data]

    elif isinstance(data, str):
        # 1. Attempt to parse string as JSON to catch embedded JSON payloads
        try:
            parsed = json.loads(data)
            if isinstance(parsed, (dict, list)):
                censored_json = censor_data(parsed)
                # Dump it back to string format
                data = json.dumps(censored_json)
        except (json.JSONDecodeError, TypeError, ValueError):
            pass  # Not valid JSON, proceed to raw string replacements

        # 2. Catch authorization bearer tokens in raw text (case-insensitive)
        data = re.sub(
            r'(?i)\bBearer\s+[^\s&\r\n]+',
            'Bearer CENSORED_AUTH',
            data
        )

        # 3. Catch URL-encoded form data or query strings (e.g., x-csrf-token=value)
        for key, replacement in CENSOR_MAP.items():
            # Matches key=value where value is anything until the next '&' or end of string
            pattern_form = rf'(?i)({re.escape(key)}=)[^&\r\n]+'
            data = re.sub(pattern_form, rf'\g<1>{replacement}', data)

        # 4. Redact values of obviously sensitive query keys regardless of case
        for key in SENSITIVE_QUERY_KEYS:
            pattern = rf'(?i)({re.escape(key)}=)[^&\r\n]+'
            data = re.sub(pattern, rf'\g<1>CENSORED_{key.upper()}', data)

        return data

    else:
        return data


def _find_header(headers: List[Dict[str, str]], name: str) -> Optional[str]:
    """Look up a header value case-insensitively."""
    name_lower = name.lower()
    for header in headers:
        if header.get("name", "").lower() == name_lower:
            return header.get("value", "")
    return None


def _censor_headers(headers: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Return a censored copy of a HAR-style header list."""
    censored: List[Dict[str, str]] = []
    for header in headers:
        name = header.get("name", "")
        value = header.get("value", "")
        name_lower = name.lower()
        if name_lower in CENSOR_MAP:
            value = CENSOR_MAP[name_lower]
        else:
            value = censor_data(value)
        censored.append({"name": name, "value": value})
    return censored


def _extract_payload(post_data: Optional[Dict[str, Any]]) -> str:
    """Extract request payload text from HAR postData, handling both 'text' and 'params'."""
    if not post_data:
        return ""

    text = post_data.get("text", "")
    if text:
        return text

    params = post_data.get("params")
    if params:
        try:
            return "&".join(
                f"{p.get('name', '')}={p.get('value', '')}" for p in params
            )
        except (AttributeError, TypeError):
            return json.dumps(params)
    return ""


def _extract_response_text(content: Optional[Dict[str, Any]]) -> str:
    """Extract response text, decoding base64 content when necessary."""
    if not content:
        return ""

    text = content.get("text", "")
    encoding = content.get("encoding", "")

    if not text:
        return ""

    if isinstance(encoding, str) and encoding.lower() == "base64":
        import base64
        try:
            return base64.b64decode(text, validate=True).decode("utf-8", errors="replace")
        except (ValueError, TypeError):
            return text

    return text


def process_har(filepath: str) -> List[Dict[str, Any]]:
    """Parse the HAR/JSON file and extract the simplified, censored requests."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

        # Handle both full HAR formats and raw JSON list excerpts
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            # Wrap in array if it's a raw excerpt missing brackets
            data = json.loads(f"[{content}]")

    if not isinstance(data, dict):
        raise ValueError("HAR root must be a JSON object.")

    log = data.get("log")
    if log is None:
        raise ValueError("Missing 'log' key in HAR root.")
    if not isinstance(log, dict):
        raise ValueError("'log' key must be a JSON object.")

    entries = log.get("entries")
    if not isinstance(entries, list):
        raise ValueError("Missing or invalid 'entries' array in HAR log.")

    parsed_requests: List[Dict[str, Any]] = []

    for entry in entries:
        if not isinstance(entry, dict):
            continue

        req = entry.get('request', {})
        res = entry.get('response', {})

        if not isinstance(req, dict) or not isinstance(res, dict):
            continue

        req_headers = req.get('headers', [])
        res_headers = res.get('headers', [])

        if isinstance(req_headers, list):
            req_headers = _censor_headers(req_headers)
        else:
            req_headers = []

        if isinstance(res_headers, list):
            res_headers = _censor_headers(res_headers)
        else:
            res_headers = []

        req_content_type = _find_header(req_headers, "Content-Type") or ""
        res_content_type = _find_header(res_headers, "Content-Type") or ""
        status = res.get("status", 0)
        status_text = res.get("statusText", "")

        payload = _extract_payload(req.get("postData"))
        response_text = _extract_response_text(res.get("content"))

        # Build the simplified object
        simplified: Dict[str, Any] = {
            "url": censor_url_credentials(req.get("url", "UNKNOWN_URL")),
            "method": req.get("method", "UNKNOWN_METHOD"),
            "request_headers": req_headers,
            "response_headers": res_headers,
            "content_type": req_content_type,
            "response_content_type": res_content_type,
            "status": status,
            "status_text": status_text,
            "payload": payload,
            "response": response_text
        }

        # Apply censorship
        parsed_requests.append(censor_data(simplified))

    return parsed_requests


def terminal_ui(stdscr: Any, requests: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Display interactive curses UI for selecting requests."""
    curses.curs_set(0)  # Hide cursor
    stdscr.nodelay(0)   # Blocking input

    current_row = 0
    selected_indices: set = set()

    while True:
        stdscr.clear()
        height, width = stdscr.getmaxyx()

        # Guard against terminals too small to render anything useful
        if height < 3 or width < 10:
            stdscr.addstr(0, 0, "Terminal too small. Resize and press any key.")
            stdscr.refresh()
            stdscr.getch()
            continue

        title = " Select requests to export (SPACE to toggle, ENTER to confirm, UP/DOWN to navigate) "
        stdscr.addstr(0, 0, title[:width], curses.A_REVERSE)

        # Display list with scroll support if it exceeds terminal height
        max_display = max(0, height - 2)
        start_idx = max(0, current_row - max_display // 2)
        end_idx = min(len(requests), start_idx + max_display)

        for i in range(start_idx, end_idx):
            req = requests[i]
            y = i - start_idx + 1

            checkbox = "[X]" if i in selected_indices else "[ ]"
            text = f"{checkbox} {req['method']} {req['url']}"

            # Truncate text to fit terminal width
            text = text[:width]

            if y < height:
                if i == current_row:
                    attr = curses.A_REVERSE | curses.A_BOLD if i in selected_indices else curses.A_REVERSE
                else:
                    attr = curses.A_BOLD if i in selected_indices else curses.A_NORMAL
                stdscr.addstr(y, 0, text, attr)

        stdscr.refresh()

        key = stdscr.getch()

        if key == curses.KEY_UP:
            current_row = (current_row - 1) % len(requests)
        elif key == curses.KEY_DOWN:
            current_row = (current_row + 1) % len(requests)
        elif key == ord(' '):
            if current_row in selected_indices:
                selected_indices.remove(current_row)
            else:
                selected_indices.add(current_row)
        elif key == ord('\n'):
            break

    return [requests[i] for i in sorted(selected_indices)]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse a HAR file, censor sensitive tokens, and interactively select requests to export."
    )
    parser.add_argument(
        "filepath",
        help="Path to the input HAR or JSON file."
    )
    parser.add_argument(
        "-o", "--output",
        default="filtered_requests.json",
        help="Path for the output JSON file (default: filtered_requests.json)"
    )
    parser.add_argument(
        "-a", "--all",
        action="store_true",
        help="Export all requests without opening the interactive UI."
    )

    # Show help if no arguments are provided
    if len(sys.argv) == 1:
        parser.print_help(sys.stderr)
        sys.exit(1)

    args = parser.parse_args()

    input_file = args.filepath
    output_file = args.output

    if not os.path.exists(input_file):
        print(f"Error: Could not find file '{input_file}'.")
        sys.exit(1)

    try:
        parsed_requests = process_har(input_file)

        if not parsed_requests:
            print("No valid requests found to parse.")
            return

        # Run the UI unless --all was requested
        if args.all:
            selected_requests = parsed_requests
        else:
            selected_requests = curses.wrapper(terminal_ui, parsed_requests)

        if not selected_requests:
            print("No requests selected. Exiting without saving.")
            return

        # Export the selected requests
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(selected_requests, f, indent=2)

        print(f"Successfully exported {len(selected_requests)} requests to {output_file}")

    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        sys.exit(1)
    finally:
        # Remove any __pycache__ directory that Python may have generated so the
        # extension folder stays clean (folders with leading underscores are
        # reserved and can break extension loading).
        cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__pycache__")
        if os.path.isdir(cache_dir):
            shutil.rmtree(cache_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
