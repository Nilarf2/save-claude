#!/usr/bin/env python3
"""Explicit, provider-configured image generation/edit client. Preview is the default."""
import argparse
import base64
import json
import binascii
import http.client
import ipaddress
import socket
import time
import mimetypes
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_BYTES = 50 * 1024 * 1024
DOWNLOAD_TIMEOUT = 30  # Socket operations; total body transfer also has a deadline.


class ImageResponseError(ValueError):
    """Only fixed, safe messages: never include provider text or signed URLs."""


class PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        # Resolve once and pin the connection to a vetted address, avoiding DNS rebinding.
        addresses = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        ips = [ipaddress.ip_address(item[4][0]) for item in addresses]
        if not ips or any(not ip.is_global or ip.is_multicast or getattr(ip, "is_site_local", False) for ip in ips):
            raise ImageResponseError("图片 URL 必须指向公网地址，不能是本机、私网或保留地址")
        self.sock = socket.create_connection(addresses[0][4][:2], self.timeout)
        try:
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)
        except Exception:
            self.sock.close()
            raise


def download_image(value):
    try:
        url = urllib.parse.urlsplit(value)
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.fragment or "%" in url.hostname or url.port not in (None, 443)
                or any(ord(char) <= 32 or ord(char) >= 127 for char in value)):
            raise ValueError()
    except (ValueError, TypeError):
        raise ImageResponseError("图片 URL 必须是无用户名/密码/片段的 HTTPS 公网地址（端口 443）") from None
    connection = PublicHTTPSConnection(url.hostname, timeout=DOWNLOAD_TIMEOUT)
    try:
        deadline = time.monotonic() + DOWNLOAD_TIMEOUT
        # A fresh, direct connection never inherits API credentials, cookies or proxy settings.
        connection.request("GET", urllib.parse.urlunsplit(("", "", url.path or "/", url.query, "")),
                           headers={"Accept": "image/*"})
        # getresponse() may detach a closing socket; retain it for body deadlines.
        transport = connection.sock
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ImageResponseError("图片下载超时（上限 30 秒）")
        if transport is not None:
            transport.settimeout(remaining)
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise ImageResponseError("图片下载返回重定向；为安全起见未跟随")
        if response.status != 200:
            raise ImageResponseError("图片下载失败：服务未返回 HTTP 200")
        length = response.getheader("Content-Length")
        if length is not None:
            try:
                length = int(length)
            except ValueError:
                raise ImageResponseError("图片下载响应的 Content-Length 无效") from None
            if length < 0 or length > MAX_BYTES:
                raise ImageResponseError("图片下载超过 50 MiB 或长度无效")
        raw = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImageResponseError("图片下载超时（上限 30 秒）")
            if transport is not None:
                transport.settimeout(remaining)
            chunk = response.read1(min(64 * 1024, MAX_BYTES + 1 - len(raw)))
            raw.extend(chunk)
            if len(raw) > MAX_BYTES:
                raise ImageResponseError("图片下载超过 50 MiB")
            if not chunk:
                break
        if length is not None and len(raw) != length:
            raise ImageResponseError("图片下载不完整")
        return bytes(raw)
    except ImageResponseError:
        raise
    except TimeoutError:
        raise ImageResponseError("图片下载超时（套接字超时或 30 秒传输时限）") from None
    except Exception:
        raise ImageResponseError("图片下载失败：请检查网络、TLS 和图片链接有效期") from None
    finally:
        connection.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        # Never forward an authorization header to an unapproved redirect target.
        return None


def build_body(prompt, model, size, refs, background=None, mask=None):
    fields = {"model": model, "prompt": prompt, "n": 1, "size": size}
    if background:
        fields["background"] = background
    if mask and not refs:
        raise ValueError("蒙版编辑必须同时提供参考图")
    if not refs:
        return json.dumps(fields, ensure_ascii=False).encode(), "application/json"
    boundary = "----image-client-" + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    # Lists preserve every reference; dictionaries silently discard repeated image fields.
    for index, path in enumerate(refs):
        field = "image[]" if len(refs) > 1 else "image"
        suffix = Path(path).suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise ValueError("参考图必须是 PNG/JPEG/WebP")
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="reference-{index}{suffix}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
        body += Path(path).read_bytes() + b"\r\n"
        if len(body) > MAX_BYTES:
            raise ValueError("请求超过 50 MiB")
    if mask:
        raw = Path(mask).read_bytes()
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("蒙版必须为 PNG")
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="mask"; filename="mask.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
        body += raw + b"\r\n"
        if len(body) > MAX_BYTES:
            raise ValueError("请求超过 50 MiB")
    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def save_response(response, output):
    if (not isinstance(response, dict) or not isinstance(response.get("data"), list)
            or not response["data"] or not isinstance(response["data"][0], dict)):
        raise ImageResponseError("响应格式错误：需要非空 data 数组及首个图片对象")
    item = response["data"][0]
    if isinstance(item.get("b64_json"), str) and item["b64_json"]:
        if len(item["b64_json"]) > ((MAX_BYTES + 2) // 3) * 4:
            raise ImageResponseError("图片超过 50 MiB")
        try:
            raw = base64.b64decode(item["b64_json"], validate=True)
        except (ValueError, binascii.Error):
            raise ImageResponseError("响应图片的 b64_json 不是有效 Base64") from None
    elif isinstance(item.get("url"), str) and item["url"]:
        raw = download_image(item["url"])
    else:
        raise ImageResponseError("响应格式错误：data[0] 需要非空 b64_json 或 HTTPS url")
    if len(raw) > MAX_BYTES:
        raise ImageResponseError("图片超过 50 MiB")
    suffix = Path(output).suffix.lower()
    valid = (suffix == ".png" and raw.startswith(b"\x89PNG\r\n\x1a\n")) or (suffix in {".jpg", ".jpeg"} and raw.startswith(b"\xff\xd8\xff")) or (suffix == ".webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    if not valid:
        raise ImageResponseError("响应图片格式与 --out 扩展名不匹配")
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_bytes(raw)
    return len(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, help="完整 HTTPS generation/edit 地址；由项目配置")
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--ref", action="append", default=[])
    parser.add_argument("--mask", help="可选 PNG 蒙版；尺寸、透明度语义以提供方的编辑接口为准")
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", default="1024x1536")
    parser.add_argument("--background", choices=["transparent", "opaque", "auto"])
    parser.add_argument("--key-env", default="IMAGE_API_KEY", help="仅从该进程环境变量读取凭据")
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--execute", action="store_true", help="显式发出一次可能收费的请求；不自动重试")
    args = parser.parse_args()
    url = urllib.parse.urlparse(args.endpoint)
    if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment:
        parser.error("--endpoint 必须是无用户名/密码/查询串的 HTTPS 地址")
    output = Path(args.out).resolve()
    inputs = [Path(args.prompt_file).resolve(), *[Path(ref).resolve() for ref in args.ref], *([Path(args.mask).resolve()] if args.mask else [])]
    if output in inputs or output.exists():
        parser.error("输出不得覆盖输入或已有图片，请换用新文件名")
    if not 0 < args.timeout <= 600:
        parser.error("--timeout 必须在 (0, 600] 秒")
    prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    if not prompt.strip():
        parser.error("提示词不能为空")
    body, content_type = build_body(prompt, args.model, args.size, args.ref, args.background, args.mask)
    if len(body) > MAX_BYTES:
        parser.error("请求超过 50 MiB")
    if not args.execute:
        print(json.dumps({"mode": "preview", "references": len(args.ref), "mask": bool(args.mask), "request_bytes": len(body), "out": str(output), "network": False}, ensure_ascii=False))
        return 0
    key = os.environ.get(args.key_env)
    if not key:
        parser.error("指定的凭据环境变量未设置")
    request = urllib.request.Request(args.endpoint, data=body, headers={"Content-Type": content_type, "Authorization": "Bearer " + key}, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=args.timeout) as response:
            data = response.read(MAX_BYTES+1)
        if len(data) > MAX_BYTES:
            raise ValueError("响应过大")
        try:
            payload = json.loads(data)
        except (ValueError, UnicodeError):
            raise ImageResponseError("提供方响应不是有效 JSON") from None
        size = save_response(payload, output)
        print(json.dumps({"ok": True, "out": str(output), "bytes": size}, ensure_ascii=False))
        return 0
    except Exception as error:
        # Providers may echo prompts/credentials in response bodies or exception strings.
        print(json.dumps({"ok": False, "error_type": type(error).__name__, "message": str(error) if isinstance(error, ImageResponseError) else "请求或保存失败；请检查网络、提供方状态及输出路径", "status": getattr(error, "code", None), "note": "没有自动重试；超时后请先确认服务端任务状态，避免重复计费。"}, ensure_ascii=False), file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
