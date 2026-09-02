#!/usr/bin/env python3
# /// script
# dependencies = ["requests", "html2text", "beautifulsoup4"]
# ///

import argparse
import re
import sys
import urllib.parse
from collections.abc import Sequence
from pathlib import Path

import html2text
import requests
from bs4 import BeautifulSoup

# Repairs text that was mis-decoded as Latin-1 instead of UTF-8 (mojibake).
# 2-byte UTF-8 chars look like "\u00c3\u00a9"; 3-byte like "\u00e2\u0080\u0094".
_MOJI_RE = re.compile(r"(?:Ã|Â)[\u0080-\u00bf]|â[\u0080-\u00bf]{2}")

# Zero-width and other invisible formatting characters (safe to drop).
_INVISIBLE_RE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff\u00ad\u180e\u200e\u200f]")


def fetch(url: str, timeout: int = 30) -> str:
    """Fetch HTML content from a URL, automatically resolving encoding."""
    if not urllib.parse.urlparse(url).scheme:
        url = f"https://{url}"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0 Safari/537.36 html2md"
        )
    }
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()

    if not resp.encoding or resp.encoding.lower() in (
        "iso-8859-1",
        "latin-1",
        "us-ascii",
    ):
        meta = re.search(
            rb'<meta[^>]+charset=["\']?([\w.-]+)', resp.content[:2048], re.IGNORECASE
        )
        resp.encoding = meta.group(1).decode() if meta else resp.apparent_encoding

    return resp.text


def sanitize(text: str) -> str:
    """Fix mojibake artifacts and remove zero-width formatting characters."""
    text = _MOJI_RE.sub(
        lambda m: m.group(0).encode("latin-1").decode("utf-8", "replace"), text
    )
    return _INVISIBLE_RE.sub("", text)


def clean(html: str, base_url: str) -> str:
    """Strip navigation, script, and non-content tags from HTML, converting relative URLs to absolute."""
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "noscript", "template", "svg", "iframe"]):
        tag.decompose()

    for tag in soup(["nav", "header", "footer", "aside", "form", "button"]):
        tag.decompose()

    for tag in soup.find_all(attrs={"hidden": True}):
        tag.decompose()

    for tag in soup(["h1", "h2", "h3", "h4", "h5", "h6"]):
        text = tag.get_text(" ", strip=True)
        if not text:
            tag.decompose()

    def to_absolute(attr: str) -> None:
        for tag in soup.find_all(attrs={attr: True}):
            value = tag[attr]
            if value and not value.startswith(
                ("http://", "https://", "mailto:", "#", "data:", "tel:", "javascript:")
            ):
                tag[attr] = urllib.parse.urljoin(base_url, value)

    to_absolute("href")
    to_absolute("src")

    return str(soup)


def convert(html: str) -> str:
    """Convert clean HTML string to structured Markdown text."""
    h = html2text.HTML2Text()
    h.body_width = 0
    h.ignore_links = False
    h.ignore_images = False
    h.protect_links = True
    h.single_line_break = False
    h.unicode_snob = True
    h.ignore_emphasis = False
    return h.handle(html).strip() + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point for html2md converter."""
    parser = argparse.ArgumentParser(
        prog="html2md",
        description="Fetch a webpage and convert it to a Markdown file.",
    )
    parser.add_argument("url", help="The URL of the HTML website to convert")
    parser.add_argument(
        "-o",
        "--output",
        help="Output Markdown file path (default: <hostname>.md in the current directory)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Timeout in seconds for the HTTP request (default: 30)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Print progress information to stderr",
    )
    args = parser.parse_args(argv)

    try:
        url = args.url if urllib.parse.urlparse(args.url).scheme else f"https://{args.url}"
        hostname = urllib.parse.urlparse(url).netloc or "output"
        output_path = Path(args.output) if args.output else Path(f"{hostname}.md")

        if args.verbose:
            print(f"[html2md] fetching {url}", file=sys.stderr)
        html = fetch(url, args.timeout)

        if args.verbose:
            print(f"[html2md] cleaning {len(html):,} bytes of HTML", file=sys.stderr)
        html = clean(html, url)
        html = sanitize(html)

        markdown = convert(html)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(markdown, encoding="utf-8")

        print(f"Saved {output_path} ({len(markdown):,} bytes)")
        return 0
    except requests.RequestException as exc:
        print(f"Error fetching {args.url}: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"Error writing output: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
