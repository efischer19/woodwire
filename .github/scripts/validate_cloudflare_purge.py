import json
import pathlib
import sys


def main() -> int:
    http_status = int(sys.argv[1])
    response_path = pathlib.Path(sys.argv[2])
    raw_response = response_path.read_text()

    try:
        payload = json.loads(raw_response)
    except json.JSONDecodeError:
        print(
            f"Cloudflare cache purge failed (invalid JSON response, status={http_status}).",
            file=sys.stderr,
        )
        print(raw_response, file=sys.stderr)
        return 1

    if not (200 <= http_status < 400) or not payload.get("success"):
        failure_kind = "HTTP error" if not (200 <= http_status < 400) else "Cloudflare API error"
        print(
            f"Cloudflare cache purge failed ({failure_kind}, status={http_status}).",
            file=sys.stderr,
        )
        print(json.dumps(payload, indent=2), file=sys.stderr)
        return 1

    print("✅ Cloudflare cache purged successfully")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
