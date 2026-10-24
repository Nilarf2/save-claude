#!/usr/bin/env python3
"""Explicit, provider-configured image generation/edit client. Preview is the default."""
import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_BYTES = 50 * 1024 * 1024


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
    item = response["data"][0]
    # URL downloads are intentionally unsupported: no uncontrolled hosts or auth forwarding.
    raw = base64.b64decode(item["b64_json"], validate=True)
    if len(raw) > MAX_BYTES:
        raise ValueError("图片超过 50 MiB")
    suffix = Path(output).suffix.lower()
    valid = (suffix == ".png" and raw.startswith(b"\x89PNG\r\n\x1a\n")) or (suffix in {".jpg", ".jpeg"} and raw.startswith(b"\xff\xd8\xff")) or (suffix == ".webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    if not valid:
        raise ValueError("响应图片格式与 --out 扩展名不匹配")
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
        size = save_response(json.loads(data), output)
        print(json.dumps({"ok": True, "out": str(output), "bytes": size}, ensure_ascii=False))
        return 0
    except Exception as error:
        # Providers may echo prompts/credentials in response bodies or exception strings.
        print(json.dumps({"ok": False, "error_type": type(error).__name__, "status": getattr(error, "code", None), "note": "没有自动重试；超时后请先确认服务端任务状态，避免重复计费。"}, ensure_ascii=False), file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
