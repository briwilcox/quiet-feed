"""Run the local server:  python -m quiet_feed_local [--port 8765] [--extension-id ID]"""

from __future__ import annotations

import argparse
from http.server import ThreadingHTTPServer

from .app import MODEL_ID, make_handler


def pick_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.backends.mps.is_available():
        return "mps"  # Apple GPU: about 7x faster than CPU in testing, same scores
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Local GLiNER2.5-Decide server for Quiet Feed.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default=MODEL_ID, help="Hugging Face id or local path")
    parser.add_argument("--device", default="auto", help="auto, mps, cuda, or cpu")
    parser.add_argument(
        "--extension-id",
        help="Only accept requests from this extension id (shown on chrome://extensions)",
    )
    parser.add_argument("--quiet", action="store_true", help="Do not log request lines")
    args = parser.parse_args(argv)

    # Imported here so --help and the tests work without the model libraries.
    from gliner2 import AutoExtractor

    device = pick_device(args.device)
    print(f"Loading {args.model} on {device} (the first run downloads about 2 GB from Hugging Face)…", flush=True)  # mutation-ignore: flushing only changes when output appears
    model = AutoExtractor.from_pretrained(args.model)
    model.to(device)

    handler = make_handler(model, port=args.port, extension_id=args.extension_id, model_id=args.model, device=device)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    server.quiet = args.quiet
    print(f"Quiet Feed local server ready on http://127.0.0.1:{args.port}", flush=True)  # mutation-ignore: flushing only changes when output appears
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
