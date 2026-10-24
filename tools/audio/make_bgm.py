#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_bgm.py — 为文字冒险游戏《拯救 Claude 大小姐》合成 16 首氛围 BGM + 4 个音效。

设计要点
--------
* 纯 numpy 合成，不依赖 ffmpeg / scipy / 外部采样素材。
* 合成器代码与输出音频的授权范围分别见根目录 LICENSE 与 ASSET-LICENSE.md。
* 无缝循环：
    - 持续铺底 / 嗡鸣  -> 频域加法合成（一次 irfft 生成全部正弦分音，频率量化到循环长度整数倍）
    - 雨 / 火 / 风 / 人群噪声 -> 频域整形噪声（在整段长度上做循环 FFT 整形，天然周期）
    - 混响 -> 与合成脉冲响应做【循环】卷积，尾音折回曲首，循环点不会断
    - 事件（音符）靠近曲尾时自动折回曲首
* 输出：48 kHz / 立体声 / MP3 128 kbps，另附 OGG Vorbis（web/story.json 引用的是 .ogg，浏览器支持 gapless 循环）

用法
----
    python tools/audio/make_bgm.py                    # 生成全部 BGM + SFX
    python tools/audio/make_bgm.py --only organ_echo,piano_warm
    python tools/audio/make_bgm.py --only-sfx
    python tools/audio/make_bgm.py --formats mp3
    python tools/audio/make_bgm.py --force            # 覆盖已存在文件
    python tools/audio/make_bgm.py --verify           # 只检查已生成文件
    python tools/audio/make_bgm.py --list
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zlib
from typing import Callable, Dict, List, Sequence, Tuple

import numpy as np

try:
    import lameenc  # MP3 编码
except ImportError:  # pragma: no cover
    lameenc = None

try:
    import soundfile as sf  # OGG Vorbis 编码 + 校验
except ImportError:  # pragma: no cover
    sf = None

SR = 48000
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BGM_DIR = os.path.join(ROOT, "web", "assets", "bgm")
SFX_DIR = os.path.join(ROOT, "web", "assets", "sfx")
REPORT_PATH = os.path.join(ROOT, "tools", "audio", "last_report.json")


# --------------------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------------------
def mtof(m: float) -> float:
    """MIDI 音高 -> 频率"""
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))


def sec(s: float, n: int) -> int:
    return int(round(s * SR))


def _smooth(v: int) -> bool:
    """只含 2/3/5 质因子的整数，numpy FFT 处理最快。"""
    for p in (2, 3, 5):
        while v % p == 0:
            v //= p
    return v == 1


def loop_len(target_s: float) -> int:
    """挑选 60~90 秒内、FFT 友好的循环长度（2/3/5 平滑，0.05s 网格）。"""
    grid = sec(0.05, 0)
    k0 = int(target_s * SR) // grid
    for k in range(k0, k0 - 600, -1):
        n = k * grid
        if 58.0 <= n / SR <= 92.0 and _smooth(k):
            return n
    return k0 * grid


def fit_step(n: int, step_s: float) -> float:
    """把节拍步长微调成能整除整个循环（鼓点/琶音在循环点严格对齐）。"""
    k = max(1, int(round((n / SR) / step_s)))
    return (n / SR) / k


def pan_gain(pan: float) -> Tuple[float, float]:
    """等功率声像，pan ∈ [-1, 1]"""
    theta = (float(np.clip(pan, -1.0, 1.0)) + 1.0) * np.pi / 4.0
    return float(np.cos(theta)), float(np.sin(theta))


def smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def additive(n: int, partials: Sequence[Tuple[float, float, float]]) -> np.ndarray:
    """频域加法合成：一次 irfft 生成全部分音，且【严格以 n 为周期】（可无缝循环）。

    partials: [(freq_hz, amplitude, phase_rad), ...]
    """
    spec = np.zeros(n // 2 + 1, dtype=np.complex64)
    kmax = n // 2
    for f, a, ph in partials:
        if not np.isfinite(f) or a <= 0.0 or f < 8.0 or f >= SR * 0.48:
            continue
        k = int(round(f * n / SR))
        if k < 1 or k >= kmax:
            continue
        spec[k] += complex(a * n * 0.5 * np.cos(ph), a * n * 0.5 * np.sin(ph))
    return np.fft.irfft(spec, n).astype(np.float32)


def sine_sum(n: int, parts: Sequence[Tuple[float, float, float]]) -> np.ndarray:
    """若干正弦（频率量化到循环整数倍，保证首尾相接）。比 additive 更省。"""
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    out = np.zeros(n, dtype=np.float32)
    for f, a, ph in parts:
        if a <= 0.0 or f <= 0.0:
            continue
        k = max(1, int(round(f * n / SR)))
        fq = np.float32(k * SR / n)
        out += np.float32(a) * np.sin(np.float32(2 * np.pi) * fq * t + np.float32(ph))
    return out


def lfo(n: int, cycles: float, depth: float = 0.0, base: float = 1.0,
        phase: float = 0.0, shape: str = "sin") -> np.ndarray:
    """循环安全的慢速 LFO（cycles 为整数，对应整首曲子长度）。"""
    t = np.arange(n, dtype=np.float32) / np.float32(n)
    if shape == "sin":
        w = np.sin(np.float32(2 * np.pi) * (np.float32(cycles) * t + np.float32(phase)))
    elif shape == "tri":
        w = 2.0 * np.abs(((cycles * t + phase) % 1.0) * 2.0 - 1.0) - 1.0
    else:
        w = np.sin(np.float32(2 * np.pi) * (np.float32(cycles) * t + np.float32(phase)))
    return (base + depth * w).astype(np.float32)


def bump(n: int, start_s: float, dur_s: float, power: float = 1.0) -> np.ndarray:
    """半正弦窗口（两端为 0，圆滑进出），用于“和弦渐入渐出”。"""
    w = np.zeros(n, dtype=np.float32)
    i0 = max(0, sec(start_s, n))
    i1 = min(n, i0 + sec(dur_s, n))
    if i1 - i0 < 4:
        return w
    x = np.linspace(0.0, np.pi, i1 - i0, dtype=np.float32)
    w[i0:i1] = np.sin(x) ** power
    return w


def place(buf: np.ndarray, sig: np.ndarray, start_s: float, gain: float = 1.0, pan: float = 0.0) -> None:
    """把单声道信号叠加到立体声总线，超出曲尾的部分折回曲首（循环无缝）。"""
    n = buf.shape[0]
    L = int(sig.shape[0])
    if L <= 0 or gain == 0.0:
        return
    if L > n:
        sig = sig[:n]
        L = n
    start = sec(start_s, n) % n
    gl, gr = pan_gain(pan)
    end = start + L
    if end <= n:
        buf[start:end, 0] += sig * np.float32(gain * gl)
        buf[start:end, 1] += sig * np.float32(gain * gr)
    else:
        k = n - start
        buf[start:n, 0] += sig[:k] * np.float32(gain * gl)
        buf[start:n, 1] += sig[:k] * np.float32(gain * gr)
        r = L - k
        buf[0:r, 0] += sig[k:] * np.float32(gain * gl)
        buf[0:r, 1] += sig[k:] * np.float32(gain * gr)


def rms_db(x: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(np.square(x.astype(np.float64))) + 1e-20))
    return 20.0 * np.log10(r + 1e-12)


# --------------------------------------------------------------------------------------
# 噪声 / 合成乐器
# --------------------------------------------------------------------------------------
def noise_layer(n: int, rng: np.random.Generator, tilt: float = -0.5,
                lo: float = 20.0, hi: float = 16000.0,
                bump_f: float | None = None, bump_w: float = 0.5,
                bump_gain: float = 1.5) -> np.ndarray:
    """频域整形噪声（在整段长度上循环整形 => 首尾天然衔接）。tilt: 0=白噪 -0.5=粉噪 -1=棕噪"""
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    f = np.maximum(f, 1.0)
    shape = f ** float(tilt)
    shape *= (f / (f + lo)) ** 1.5
    shape *= 1.0 / np.sqrt(1.0 + (f / hi) ** 4)
    if bump_f:
        shape *= 1.0 + bump_gain * np.exp(-0.5 * (np.log(f / bump_f) / bump_w) ** 2)
    y = np.fft.irfft(X * shape, n).astype(np.float32)
    y /= float(np.sqrt(np.mean(np.square(y))) + 1e-12)
    return y


def pad_layer(notes: Sequence[float], n: int, rng: np.random.Generator,
              harm: Sequence[float] = (1, 2, 3, 4, 5, 6),
              amps: Sequence[float] | None = None,
              detune: float = 0.0016, fmax: float = 11000.0,
              width: float = 0.35) -> np.ndarray:
    """铺底和弦：每个音若干谐波 + 双失谐（合唱/弦乐感）。返回单声道（宽度靠 finish 的立体声扩展）。"""
    parts: List[Tuple[float, float, float]] = []
    for mnote in notes:
        f0 = mtof(mnote)
        for i, h in enumerate(harm):
            a = float(amps[i]) if amps and i < len(amps) else 1.0 / (float(h) ** 1.6)
            if a <= 1e-4:
                continue
            for sign in (-1.0, 1.0):
                f = f0 * h * (1.0 + sign * detune * (0.4 + 0.8 * rng.random()) * width * 2.0)
                if f < 15.0 or f > fmax:
                    continue
                parts.append((f, a * 0.45, rng.uniform(0.0, 2.0 * np.pi)))
    return additive(n, parts)


_NOTE_KINDS: Dict[str, dict] = {
    #  ratio,        amp,   tau(相对值)
    "piano": dict(ratios=[1.0, 2.001, 3.004, 4.01, 5.02, 6.05, 7.1, 8.2],
                  amps=[1.0, 0.52, 0.3, 0.17, 0.1, 0.055, 0.03, 0.02],
                  taus=[1.0, 0.66, 0.46, 0.33, 0.24, 0.18, 0.13, 0.1], inharm=0.0004),
    "music_box": dict(ratios=[1.0, 2.0, 3.01, 4.97, 7.2, 9.8],
                      amps=[1.0, 0.4, 0.19, 0.1, 0.045, 0.02],
                      taus=[0.55, 0.3, 0.19, 0.12, 0.08, 0.055], inharm=0.0012),
    "marimba": dict(ratios=[1.0, 3.93, 9.2, 16.0],
                    amps=[1.0, 0.32, 0.1, 0.03],
                    taus=[0.7, 0.2, 0.09, 0.05], inharm=0.0),
    "bell": dict(ratios=[2.0, 2.76, 3.0, 4.07, 5.4, 6.8, 8.9],
                 amps=[1.0, 0.55, 0.42, 0.3, 0.16, 0.09, 0.05],
                 taus=[1.0, 0.85, 0.8, 0.55, 0.4, 0.28, 0.2], inharm=0.0),
    "glass": dict(ratios=[1.0, 1.5, 2.03, 2.7, 3.9],
                  amps=[1.0, 0.35, 0.22, 0.12, 0.06],
                  taus=[0.8, 0.55, 0.4, 0.3, 0.2], inharm=0.0008),
    "organ": dict(ratios=[1.0, 2.0, 3.0, 4.0, 6.0, 8.0],
                  amps=[1.0, 0.62, 0.4, 0.26, 0.14, 0.08],
                  taus=[3.0, 3.0, 2.6, 2.2, 1.8, 1.4], inharm=0.0),
}


# 波表合成：把分音烘焙进一张周期表，单次查表即得整个音色（比逐分音 sin 快 20~40 倍）
_TAB_BITS = 12
_TAB_N = 1 << _TAB_BITS
_TAB_MASK = _TAB_N - 1
_TAB_CACHE: Dict[tuple, Tuple[np.ndarray, np.ndarray]] = {}


def _note_tables(kind: str, f0: float) -> Tuple[np.ndarray, np.ndarray]:
    """返回 (body, sparkle) 两张单周期波表。

    body    = 衰减慢的低次分音
    sparkle = 衰减快的高次分音（击弦/铃舌的“亮”感）
    """
    spec = _NOTE_KINDS[kind]
    taus = spec["taus"]
    tau_hi = float(np.median(taus))
    key = (kind, int(f0 / 40.0))
    hit = _TAB_CACHE.get(key)
    if hit is not None:
        return hit
    x = np.arange(_TAB_N, dtype=np.float64) / _TAB_N
    body = np.zeros(_TAB_N, dtype=np.float64)
    spark = np.zeros(_TAB_N, dtype=np.float64)
    nyq = 0.42 * SR
    for r, a, tau in zip(spec["ratios"], spec["amps"], taus):
        f = f0 * r * np.sqrt(1.0 + spec["inharm"] * r * r)
        if f > nyq:
            continue
        w = a * np.sin(2.0 * np.pi * r * x)  # 以 f0 为基频的周期波
        if tau >= tau_hi:
            body += w
        else:
            spark += w
    for tab in (body, spark):
        m = float(np.max(np.abs(tab)))
        if m > 0:
            tab /= m
    out = (body.astype(np.float32), spark.astype(np.float32))
    _TAB_CACHE[key] = out
    return out


_DEC_N = 4096
_DEC = np.exp(-6.9 * np.arange(_DEC_N, dtype=np.float32) / _DEC_N).astype(np.float32)


def _decay(n: int, tau: float) -> np.ndarray:
    """指数衰减包络（查表，避免逐音符 exp）。"""
    k = np.arange(n, dtype=np.float32) * np.float32(1.0 / max(tau * SR, 1.0)) * np.float32(_DEC_N)
    np.minimum(k, np.float32(_DEC_N - 1), out=k)
    return _DEC[k.astype(np.int32)]


def synth_note(f0: float, dur: float, kind: str = "piano", rng: np.random.Generator | None = None,
               amp: float = 1.0, detune: float = 0.0, attack: float = 0.004,
               release: float = 0.02) -> np.ndarray:
    """单音事件合成：波表查表 + 指数衰减包络。"""
    spec = _NOTE_KINDS[kind]
    n = max(32, int(round(dur * SR)))
    body_tab, spark_tab = _note_tables(kind, f0)
    base_tau = max(0.05, dur * 0.35)
    taus = spec["taus"]
    tau_hi = float(np.median(taus))
    inc = np.float32(f0 * _TAB_N / SR)
    ph = np.arange(n, dtype=np.float32) * inc
    if detune > 0.0:
        ph2 = ph * np.float32(1.0 + detune)
    else:
        ph2 = ph
    out = body_tab[(ph.astype(np.int64)) & _TAB_MASK] * _decay(n, base_tau * tau_hi)
    out += spark_tab[(ph.astype(np.int64)) & _TAB_MASK] * _decay(n, base_tau * 0.25)
    if detune > 0.0:
        out += np.float32(0.4) * body_tab[(ph2.astype(np.int64)) & _TAB_MASK] * _decay(n, base_tau * tau_hi)
    na = max(2, min(n, sec(attack, n)))
    if na > 1:
        out[:na] *= (0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, na, dtype=np.float32)))
    nr = max(2, min(n, sec(release, n)))
    if nr > 1:
        out[-nr:] *= (0.5 + 0.5 * np.cos(np.linspace(0.0, np.pi, nr, dtype=np.float32)))
    return (out * np.float32(amp)).astype(np.float32, copy=False)


# --------------------------------------------------------------------------------------
# 混响 / 母带
# --------------------------------------------------------------------------------------
def make_ir(rng: np.random.Generator, dur: float = 3.0, rt60: float = 3.0,
            damp: float = 6500.0, predelay: float = 0.02, hp: float = 90.0) -> np.ndarray:
    """合成房间脉冲响应（立体声），能量归一化。"""
    n = int(max(0.2, dur) * SR)
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    ir = np.zeros((n, 2), dtype=np.float32)
    for ch in range(2):
        x = rng.standard_normal(n)
        env = np.exp(-6.9078 * (t / np.float32(rt60))).astype(np.float32)
        X = np.fft.rfft(x * env)
        f = np.fft.rfftfreq(n, 1.0 / SR)
        f = np.maximum(f, 1.0)
        shape = 1.0 / np.sqrt(1.0 + (f / damp) ** 2) * (f / (f + hp)) ** 0.6
        y = np.fft.irfft(X * shape, n).astype(np.float32)
        peak = float(np.max(np.abs(y)) + 1e-9)
        for i in range(5):  # 早期反射
            d = int(rng.uniform(0.006, 0.075) * SR)
            if d < n:
                y[d] += float(rng.uniform(0.25, 0.7)) * (0.82 ** i) * peak
        ir[:, ch] = y
    pd = sec(predelay, n)
    if 0 < pd < n:
        ir = np.concatenate([np.zeros((pd, 2), dtype=np.float32), ir[: n - pd]], axis=0)
    ir /= float(np.sqrt(np.sum(np.square(ir, dtype=np.float64)) / 2.0) + 1e-12)
    return ir


def finish(dry: np.ndarray, rng: np.random.Generator, *, wet: float = 0.28, rt60: float = 3.0,
           ir_dur: float | None = None, predelay: float = 0.02, damp: float = 6500.0,
           rms_db_target: float = -20.0, widen: float = 0.25, hp: float = 30.0,
           lp: float = 15500.0, tilt: float = 0.0) -> np.ndarray:
    """混响（循环卷积）+ 母带（EQ / 立体声扩展 / 响度 / 软限幅 / 边缘去爆音）。"""
    n = dry.shape[0]
    X = np.fft.rfft(dry, axis=0, n=n)
    if wet > 0.0:
        ir = make_ir(rng, dur=(ir_dur if ir_dur else max(1.0, rt60 * 1.15)),
                     rt60=rt60, damp=damp, predelay=predelay)
        H = np.fft.rfft(ir, n=n, axis=0)
        Y = X * np.float32(1.0 - wet) + X * H * np.float32(wet)
        del H, ir
    else:
        Y = X
    f = np.maximum(np.fft.rfftfreq(n, 1.0 / SR), 1.0)
    eq = (f / (f + hp)) * (1.0 / np.sqrt(1.0 + (f / lp) ** 4))
    if tilt:
        eq *= (f / 1000.0) ** (tilt * 0.5)
    Y = Y * eq[:, None]
    if widen > 0.0:
        L = Y[:, 0]
        R = Y[:, 1]
        M = 0.5 * (L + R)
        S = 0.5 * (L - R) * np.float32(1.0 + widen)
        Y = np.stack([M + S, M - S], axis=1)
    out = np.fft.irfft(Y, n=n, axis=0).astype(np.float32)
    del X, Y
    out -= out.mean(axis=0, keepdims=True)
    target = float(10.0 ** (rms_db_target / 20.0))
    cur = float(np.sqrt(np.mean(np.square(out)) + 1e-20))
    out *= np.float32(target / max(cur, 1e-9))
    out = np.float32(0.97) * np.tanh(out / np.float32(0.97))
    cur = float(np.sqrt(np.mean(np.square(out)) + 1e-20))
    if cur > 1e-9:
        out *= np.float32(min(1.6, target / cur))
    peak = float(np.max(np.abs(out))) or 1e-9
    if peak > 0.99:
        out *= np.float32(0.99 / peak)
    # 循环点本身连续（循环卷积），这里只做 20ms 去编码器边角爆音的极小淡入淡出
    m = min(sec(0.02, n), n // 4)
    if m > 1:
        ramp = (0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, m, dtype=np.float32)))
        out[:m] *= ramp[:, None]
        out[-m:] *= ramp[::-1, None]
    return out.astype(np.float32)


# --------------------------------------------------------------------------------------
# 16 首 BGM
# --------------------------------------------------------------------------------------
Builder = Callable[[np.random.Generator], Tuple[np.ndarray, dict]]


def _bus(n: int) -> np.ndarray:
    return np.zeros((n, 2), dtype=np.float32)


def bgm_organ_echo(rng: np.random.Generator):
    n = loop_len(78)
    bus = _bus(n)
    # D 小调管风琴：低音持续 + 泛音列
    pad = pad_layer([38, 45, 50, 53, 57, 62], n, rng,
                    harm=(1, 2, 3, 4, 5, 6, 8), amps=(1, .55, .38, .24, .16, .1, .06),
                    detune=0.0012, width=0.3)
    place(bus, pad, 0.0, 0.62)
    # 第二和弦 Bb，缓慢渐入渐出
    pad2 = pad_layer([46, 53, 58, 62, 65], n, rng,
                     harm=(1, 2, 3, 4, 5, 6), amps=(1, .5, .34, .2, .12, .07), detune=0.0014)
    place(bus, pad2 * bump(n, 7.0, 40.0), 0.0, 0.36)
    # 16 尺低音管
    place(bus, sine_sum(n, [(36.71, 0.30, 0.0), (73.42, 0.16, 0.4), (55.0, 0.06, 1.1)]), 0.0, 0.9)
    # 缓慢呼吸
    env = lfo(n, 3, depth=0.16, base=1.0, phase=0.1)
    bus *= env[:, None]
    # 管风琴回声动机
    for t0, m, g, p in [(9.5, 69, 0.30, -0.35), (21.0, 65, 0.24, 0.4), (33.5, 72, 0.28, -0.2),
                        (47.0, 69, 0.22, 0.3), (58.5, 65, 0.2, -0.45), (68.0, 62, 0.26, 0.15)]:
        place(bus, synth_note(mtof(m), 7.5, "organ", rng, amp=1.0), t0, g, pan=p)
    # 空气感
    place(bus, noise_layer(n, rng, tilt=-0.2, lo=1800, hi=9000), 0.0, 0.045)
    return bus, dict(wet=0.5, rt60=4.6, ir_dur=5.2, predelay=0.035, damp=5200,
                     rms_db_target=-21.0, widen=0.3, lp=12500)


def bgm_sanctuary_cold(rng: np.random.Generator):
    n = loop_len(72)
    bus = _bus(n)
    # 极低频嗡鸣
    place(bus, sine_sum(n, [(41.2, 0.34, 0.0), (55.0, 0.2, 1.0), (82.4, 0.1, 2.1), (110.0, 0.05, 0.5)]),
          0.0, 0.8)
    # 玻璃质感高频（缓慢拍频）
    glass = additive(n, [(2093, .5, 0), (2093 * 1.003, .3, 1.1), (2637, .34, 2.2), (2637 * .997, .22, 0.4),
                         (3136, .26, 1.7), (3520, .14, 2.8), (4186, .1, 0.9), (4699, .07, 1.4)])
    place(bus, glass * lfo(n, 2, depth=0.4, base=0.6, phase=0.15), 0.0, 0.16, pan=0.15)
    # 玻璃回声点
    for t0, m, g in [(6.0, 100, 0.16), (18.5, 96, 0.13), (31.0, 103, 0.12), (44.0, 91, 0.14),
                     (56.5, 98, 0.12), (66.0, 96, 0.1)]:
        place(bus, synth_note(mtof(m), 6.0, "glass", rng, amp=1.0), t0, g,
              pan=float(rng.uniform(-0.6, 0.6)))
    place(bus, noise_layer(n, rng, tilt=-0.1, lo=4000, hi=14000), 0.0, 0.05)
    return bus, dict(wet=0.55, rt60=5.0, ir_dur=5.6, predelay=0.05, damp=8000,
                     rms_db_target=-26.0, widen=0.35, lp=15000)


def bgm_solemn_hymn(rng: np.random.Generator):
    n = loop_len(80)
    bus = _bus(n)
    # 四和弦进行（Dm - Bb - F - A），每个 20s，用半正弦窗交叠
    prog = [[50, 57, 62, 65, 69], [46, 53, 58, 62, 65], [41, 48, 53, 57, 60], [45, 52, 57, 61, 64]]
    for i, ch in enumerate(prog):
        pad = pad_layer(ch, n, rng, harm=(1, 2, 3, 4, 5, 6), amps=(1, .58, .36, .22, .13, .08),
                        detune=0.0018, width=0.4)
        place(bus, pad * bump(n, i * 18.0 + 1.0, 26.0, 1.0), 0.0, 0.30)
        sub = sine_sum(n, [(mtof(ch[0] - 12), 0.3, 0.0), (mtof(ch[1] - 12), 0.12, 0.9)])
        place(bus, sub * bump(n, i * 18.0 + 1.0, 26.0), 0.0, 0.8)
    # 圣咏旋律（长音）
    mel = [(4.0, 74, .26), (16.0, 72, .22), (28.0, 69, .24), (40.0, 70, .2),
           (50.0, 67, .22), (60.0, 69, .2), (70.0, 74, .18)]
    for t0, m, g in mel:
        place(bus, synth_note(mtof(m), 9.0, "organ", rng, amp=1.0), t0, g, pan=0.1)
    place(bus, noise_layer(n, rng, tilt=-0.3, lo=1200, hi=8000), 0.0, 0.035)
    bus *= lfo(n, 2, depth=0.12, base=1.0)[:, None]
    return bus, dict(wet=0.42, rt60=3.8, ir_dur=4.4, predelay=0.03, damp=5800,
                     rms_db_target=-20.5, widen=0.28, lp=13500)


def bgm_solemn_strings(rng: np.random.Generator):
    n = loop_len(82)
    bus = _bus(n)
    # 弦乐：大量谐波 + 双失谐，形成渐强
    chords = [[45, 52, 57, 60, 64], [43, 50, 55, 58, 62]]
    for i, ch in enumerate(chords):
        pad = pad_layer(ch, n, rng, harm=(1, 2, 3, 4, 5, 6, 7, 8, 9),
                        amps=(1, .7, .5, .36, .26, .18, .12, .08, .05),
                        detune=0.0022, width=0.5, fmax=9000)
        env = bump(n, i * 40.0, 48.0) * lfo(n, 5, depth=0.07, base=0.9, phase=0.3)
        place(bus, pad * env, 0.0, 0.26)
    # 低音提琴持续音
    place(bus, sine_sum(n, [(41.2, 0.3, 0.0), (61.7, 0.14, 0.7), (82.4, 0.08, 1.9)]), 0.0, 0.85)
    # 渐强（两个周期，整首缓慢起伏）
    amp = lfo(n, 2, depth=0.42, base=0.72, phase=0.25)
    bus *= amp[:, None]
    return bus, dict(wet=0.4, rt60=3.0, ir_dur=3.6, predelay=0.025, damp=4800,
                     rms_db_target=-19.5, widen=0.4, lp=12500)


def bgm_alarm_cold(rng: np.random.Generator):
    n = loop_len(66)
    bus = _bus(n)
    # 冷调不协和持续音（D + Eb 小二度）
    place(bus, sine_sum(n, [(36.7, 0.3, 0), (38.9, 0.16, 1.2), (73.4, 0.1, 2.4), (77.8, 0.06, 0.3)]), 0.0, 0.7)
    place(bus, noise_layer(n, rng, tilt=-0.35, lo=2500, hi=14000, bump_f=5200, bump_w=0.5), 0.0, 0.05)
    # 脉冲：低频心跳 + 尖锐高音
    period = fit_step(n, 1.65)
    t0 = 0.6
    idx = 0
    while t0 < n / SR - 0.1:
        lowp = synth_note(mtof(31), 0.9, "piano", rng, amp=1.0)
        place(bus, lowp, t0, 0.5)
        hi = synth_note(mtof(88 if idx % 4 else 91), 0.35, "glass", rng, amp=1.0)
        place(bus, hi, t0 + 0.02, 0.16, pan=0.3 if idx % 2 else -0.3)
        # 金属泛音
        met = additive(n, [(2400, .5, 0), (3600, .3, 1.1), (4820, .2, 2.3)])
        place(bus, met * bump(n, t0, 1.4, 2.0), 0.0, 0.05, pan=float(rng.uniform(-0.5, 0.5)))
        t0 += period
        idx += 1
    bus *= lfo(n, 4, depth=0.1, base=1.0)[:, None]
    return bus, dict(wet=0.22, rt60=1.8, ir_dur=2.2, predelay=0.015, damp=7000,
                     rms_db_target=-18.5, widen=0.25, lp=15000)


def bgm_fire_and_ash(rng: np.random.Generator):
    n = loop_len(76)
    bus = _bus(n)
    # 低频轰鸣
    rumble = noise_layer(n, rng, tilt=-1.15, lo=18, hi=140)
    place(bus, rumble * lfo(n, 3, depth=0.22, base=0.85, phase=0.4), 0.0, 0.55)
    place(bus, sine_sum(n, [(31.0, 0.22, 0), (43.5, 0.12, 1.4), (62.0, 0.06, 2.5)]), 0.0, 0.6)
    # 风 / 火声
    wind = noise_layer(n, rng, tilt=-0.6, lo=250, hi=2600, bump_f=800, bump_w=0.7, bump_gain=1.2)
    place(bus, wind * lfo(n, 5, depth=0.3, base=0.7, phase=0.7), 0.0, 0.2)
    # 噼啪爆裂：短噪声簇
    crackle = noise_layer(n, rng, tilt=0.0, lo=1200, hi=9000)
    t = 0.0
    while t < n / SR - 0.1:
        t += float(rng.exponential(0.22))
        L = int(rng.uniform(0.004, 0.05) * SR)
        if L < 8:
            continue
        seg = crackle[int(rng.uniform(0, n - L)):][:L].copy()
        seg *= np.exp(-np.linspace(0, 6, L, dtype=np.float32)) * np.float32(rng.uniform(0.15, 1.0))
        place(bus, seg, t, 0.22, pan=float(rng.uniform(-0.8, 0.8)))
    bus *= lfo(n, 2, depth=0.15, base=1.0, phase=0.2)[:, None]
    return bus, dict(wet=0.2, rt60=2.2, ir_dur=2.6, predelay=0.02, damp=4200,
                     rms_db_target=-19.0, widen=0.3, lp=11000)


def bgm_empty_silence(rng: np.random.Generator):
    n = loop_len(78)
    bus = _bus(n)
    place(bus, sine_sum(n, [(31.0, 0.5, 0), (46.5, 0.22, 1.1), (62.0, 0.1, 2.0)]), 0.0, 0.55)
    place(bus, noise_layer(n, rng, tilt=-0.9, lo=120, hi=900), 0.0, 0.06)
    place(bus, noise_layer(n, rng, tilt=-0.1, lo=5000, hi=15000), 0.0, 0.012)
    # 偶发水滴
    for t0 in [5.5, 17.0, 30.5, 41.5, 55.0, 67.0, 73.5]:
        L = int(0.16 * SR)
        tt = np.arange(L, dtype=np.float32) / np.float32(SR)
        f_env = np.linspace(1250.0, 620.0, L, dtype=np.float32)
        ph = np.cumsum((2 * np.pi * f_env / SR).astype(np.float32))
        drop = np.sin(ph.astype(np.float32)) * np.exp(-tt / np.float32(0.045))
        na = max(2, sec(0.002, L))
        drop[:na] *= np.linspace(0, 1, na, dtype=np.float32)
        place(bus, drop.astype(np.float32), t0, float(rng.uniform(0.1, 0.2)),
              pan=float(rng.uniform(-0.7, 0.7)))
    return bus, dict(wet=0.62, rt60=5.5, ir_dur=6.0, predelay=0.06, damp=7000,
                     rms_db_target=-30.0, widen=0.35, lp=14000)


def bgm_tender_solitude(rng: np.random.Generator):
    n = loop_len(78)
    bus = _bus(n)
    # 柔和 A 小调铺底
    pad = pad_layer([45, 52, 57, 60, 64], n, rng, harm=(1, 2, 3, 4, 5),
                    amps=(1, .4, .2, .11, .06), detune=0.0012, width=0.5)
    place(bus, pad * lfo(n, 1, depth=0.2, base=0.75, phase=0.1), 0.0, 0.26)
    place(bus, sine_sum(n, [(36.7, 0.14, 0), (55.0, 0.06, 1.2)]), 0.0, 0.7)
    # 稀疏钢琴单音（A 小调五声）
    notes = [69, 72, 76, 74, 69, 67, 72, 69, 76, 81, 79, 76, 72, 74, 69, 67, 64, 69]
    t0 = 3.0
    for i, m in enumerate(notes):
        dur = float(rng.uniform(2.6, 4.6))
        place(bus, synth_note(mtof(m), dur, "piano", rng, amp=1.0, detune=0.0006),
              t0, float(rng.uniform(0.16, 0.26)), pan=float(rng.uniform(-0.45, 0.45)))
        t0 += float(rng.uniform(3.0, 5.2))
        if t0 > n / SR - 3.0:
            break
    return bus, dict(wet=0.5, rt60=5.0, ir_dur=5.4, predelay=0.045, damp=6000,
                     rms_db_target=-24.5, widen=0.3, lp=13000)


def bgm_piano_warm(rng: np.random.Generator):
    n = loop_len(76)
    bus = _bus(n)
    # 温暖铺底：C - Am - F - G
    prog = [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]]
    for i, ch in enumerate(prog):
        pad = pad_layer(ch, n, rng, harm=(1, 2, 3, 4, 5), amps=(1, .42, .2, .11, .06),
                        detune=0.001, width=0.4)
        place(bus, pad * bump(n, i * 19.0, 25.0) * 0.9, 0.0, 0.16)
    # 钢琴琶音
    arps = [([60, 64, 67, 72, 67, 64], 0.0), ([57, 60, 64, 69, 64, 60], 19.0),
            ([53, 57, 60, 65, 60, 57], 38.0), ([55, 59, 62, 67, 62, 59], 57.0)]
    for pat, base in arps:
        t0 = base + 0.5
        i = 0
        while t0 < base + 19.0 and t0 < n / SR - 1.0:
            m = pat[i % len(pat)]
            if i % 6 == 4:
                m += 12
            place(bus, synth_note(mtof(m), float(rng.uniform(2.2, 3.4)), "piano", rng, amp=1.0,
                                  detune=0.0005),
                  t0, float(rng.uniform(0.2, 0.3)), pan=float(rng.uniform(-0.35, 0.35)) + (0.1 if i % 2 else -0.1))
            t0 += 0.75
            i += 1
    place(bus, sine_sum(n, [(36.7, 0.12, 0), (49.0, 0.07, 0.8)]), 0.0, 0.6)
    return bus, dict(wet=0.32, rt60=2.6, ir_dur=3.0, predelay=0.025, damp=6500,
                     rms_db_target=-22.5, widen=0.28, lp=13500)


def bgm_music_warm_box(rng: np.random.Generator):
    n = loop_len(72)
    bus = _bus(n)
    # 音乐盒 3/4 圆舞曲
    melody = [72, 76, 79, 84, 79, 76, 74, 77, 81, 86, 81, 77,
              72, 76, 79, 84, 88, 84, 79, 76, 74, 72, 71, 72]
    bass = [48, 55, 53, 55, 50, 57, 55, 57]
    step = fit_step(n, 0.42)
    t0 = 1.2
    for i, m in enumerate(melody):
        place(bus, synth_note(mtof(m), float(rng.uniform(1.2, 2.0)), "music_box", rng, amp=1.0),
              t0, float(rng.uniform(0.16, 0.24)), pan=float(np.sin(i * 0.7)) * 0.35)
        # 低音（每小节第一拍）
        if i % 6 == 0:
            bm = bass[(i // 6) % len(bass)]
            place(bus, synth_note(mtof(bm), 2.4, "music_box", rng, amp=1.0), t0 - 0.1, 0.12, pan=-0.1)
        t0 += step
        if t0 > n / SR - 0.3:
            t0 = 1.2 + (t0 - (n / SR - 0.3))  # 折回，保持循环
    # 轻微铺底
    pad = pad_layer([48, 55, 60], n, rng, harm=(1, 2, 3), amps=(1, .3, .12), detune=0.001)
    place(bus, pad * lfo(n, 2, depth=0.2, base=0.6), 0.0, 0.1)
    return bus, dict(wet=0.36, rt60=2.8, ir_dur=3.2, predelay=0.02, damp=8000,
                     rms_db_target=-21.5, widen=0.32, lp=15000)


def bgm_whimsical_warm(rng: np.random.Generator):
    n = loop_len(68)
    bus = _bus(n)
    bpm = 108.0
    step = fit_step(n, 60.0 / bpm / 2.0)  # 八分音符
    shaker_tex = noise_layer(n, rng, tilt=0.2, lo=4000, hi=13000)
    scale = [72, 74, 76, 79, 81, 84]  # C 大调五声
    melody = [0, 2, 4, 3, 2, 1, 0, 2, 4, 5, 4, 2]
    bassline = [48, 48, 55, 55, 53, 53, 55, 55]
    t0 = 0.35
    i = 0
    while t0 < n / SR - 0.4:
        m = scale[melody[i % len(melody)]]
        if i % 8 == 7:
            m += 12
        place(bus, synth_note(mtof(m), 0.55, "marimba", rng, amp=1.0),
              t0, float(rng.uniform(0.22, 0.3)), pan=float(rng.uniform(-0.3, 0.3)))
        if i % 2 == 0:
            place(bus, synth_note(mtof(bassline[(i // 2) % len(bassline)]), 0.7, "marimba", rng, amp=1.0),
                  t0, 0.2, pan=-0.15)
        # 沙锤
        if i % 2 == 1:
            seg = shaker_tex[int(rng.uniform(0, n - 2400)):][:2400].copy()
            seg *= np.exp(-np.linspace(0, 9, 2400, dtype=np.float32))
            place(bus, seg.astype(np.float32), t0, 0.07, pan=0.4)
        t0 += step
        i += 1
    pad = pad_layer([60, 64, 67], n, rng, harm=(1, 2, 3), amps=(1, .25, .1), detune=0.001)
    place(bus, pad * lfo(n, 3, depth=0.15, base=0.5), 0.0, 0.09)
    return bus, dict(wet=0.24, rt60=1.6, ir_dur=2.0, predelay=0.012, damp=8000,
                     rms_db_target=-21.0, widen=0.32, lp=15000)


def bgm_lonely_synth_rain(rng: np.random.Generator):
    n = loop_len(80)
    bus = _bus(n)
    # 低沉 synth pad（锯齿感：多谐波）
    chords = ([[38, 45, 50, 53], [36, 43, 48, 51]])
    for i, ch in enumerate(chords):
        pad = pad_layer(ch, n, rng, harm=(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
                        amps=tuple(1.0 / (h ** 0.9) for h in range(1, 11)),
                        detune=0.0035, width=0.6, fmax=5000)
        place(bus, pad * bump(n, i * 40.0, 48.0) * lfo(n, 3, depth=0.12, base=0.85), 0.0, 0.22)
    place(bus, sine_sum(n, [(36.7, 0.3, 0), (55.0, 0.12, 1.3), (73.4, 0.05, 2.2)]), 0.0, 0.75)
    # 雨
    rain = noise_layer(n, rng, tilt=-0.45, lo=700, hi=13000, bump_f=4200, bump_w=0.8, bump_gain=0.9)
    place(bus, rain, 0.0, 0.16)
    # 雨滴细节
    drops = noise_layer(n, rng, tilt=-0.2, lo=2500, hi=15000)
    t = 0.0
    while t < n / SR - 0.05:
        t += float(rng.exponential(0.55))
        L = int(rng.uniform(0.008, 0.03) * SR)
        seg = drops[int(rng.uniform(0, n - L)):][:L].copy()
        seg *= np.exp(-np.linspace(0, 8, L, dtype=np.float32)) * np.float32(rng.uniform(0.1, 0.5))
        place(bus, seg, t, 0.1, pan=float(rng.uniform(-0.8, 0.8)))
    # 霓虹感高音
    place(bus, lfo(n, 6, depth=0.5, base=0.4).astype(np.float32) *
          additive(n, [(1046.5, .12, 0), (1568, .08, 1.4), (2093, .05, 2.7)]), 0.0, 0.5)
    return bus, dict(wet=0.38, rt60=3.6, ir_dur=4.2, predelay=0.03, damp=6500,
                     rms_db_target=-21.5, widen=0.45, lp=13000)


def bgm_melancholy_rain(rng: np.random.Generator):
    n = loop_len(78)
    bus = _bus(n)
    # 雨
    place(bus, noise_layer(n, rng, tilt=-0.5, lo=600, hi=12000), 0.0, 0.15)
    place(bus, noise_layer(n, rng, tilt=-0.15, lo=3500, hi=15000), 0.0, 0.05)
    # 忧郁钢琴（D 小调）
    notes = [62, 65, 69, 74, 69, 65, 62, 60, 65, 69, 72, 69, 65, 62, 58, 62]
    t0 = 2.0
    i = 0
    while t0 < n / SR - 0.2:
        m = notes[i % len(notes)]
        place(bus, synth_note(mtof(m), float(rng.uniform(2.4, 3.8)), "piano", rng, amp=1.0,
                              detune=0.0005),
              t0, float(rng.uniform(0.18, 0.27)), pan=float(rng.uniform(-0.4, 0.4)))
        t0 += float(rng.uniform(1.6, 2.6))
        i += 1
    # 低音铺底
    pad = pad_layer([38, 45, 50, 53], n, rng, harm=(1, 2, 3, 4), amps=(1, .35, .16, .08), detune=0.0012)
    place(bus, pad * lfo(n, 2, depth=0.18, base=0.7), 0.0, 0.22)
    return bus, dict(wet=0.42, rt60=4.0, ir_dur=4.6, predelay=0.03, damp=6000,
                     rms_db_target=-22.5, widen=0.3, lp=12500)


def bgm_rain_and_clock(rng: np.random.Generator):
    n = loop_len(72)
    bus = _bus(n)
    # 雨（更近、更有颗粒感）
    place(bus, noise_layer(n, rng, tilt=-0.42, lo=800, hi=11000), 0.0, 0.14)
    # 时钟滴答：tick / tock 交替
    period = fit_step(n, 1.0)
    tick_n = int(0.05 * SR)
    tt = np.arange(tick_n, dtype=np.float32) / np.float32(SR)
    tick = (np.sin(np.float32(2 * np.pi * 2100) * tt) * np.exp(-tt / np.float32(0.006))).astype(np.float32)
    tock = (np.sin(np.float32(2 * np.pi * 1550) * tt) * np.exp(-tt / np.float32(0.008))).astype(np.float32)
    noise_t = noise_layer(n, rng, tilt=0.1, lo=1500, hi=8000)
    t0 = 0.25
    i = 0
    while t0 < n / SR - 0.05:
        seg = tick if i % 2 == 0 else tock
        place(bus, seg, t0, 0.18, pan=0.25 if i % 2 == 0 else -0.25)
        nz = noise_t[int(rng.uniform(0, n - 200)):][:200].copy() * np.exp(-np.linspace(0, 10, 200, dtype=np.float32))
        place(bus, nz.astype(np.float32), t0, 0.08)
        t0 += period
        i += 1
    # 温柔而紧迫的和声（A 小调 + 小二度）
    pad = pad_layer([45, 52, 57, 58, 60], n, rng, harm=(1, 2, 3, 4), amps=(1, .4, .18, .09), detune=0.0014)
    place(bus, pad * lfo(n, 3, depth=0.22, base=0.7), 0.0, 0.2)
    place(bus, sine_sum(n, [(36.7, 0.14, 0), (55.0, 0.06, 1.1)]), 0.0, 0.7)
    return bus, dict(wet=0.34, rt60=2.8, ir_dur=3.4, predelay=0.022, damp=6000,
                     rms_db_target=-21.5, widen=0.3, lp=13500)


def bgm_silence_snow(rng: np.random.Generator):
    n = loop_len(76)
    bus = _bus(n)
    place(bus, sine_sum(n, [(31.0, 0.42, 0), (46.5, 0.16, 1.2), (93.0, 0.04, 2.4)]), 0.0, 0.6)
    place(bus, noise_layer(n, rng, tilt=-0.2, lo=4500, hi=16000), 0.0, 0.03)
    place(bus, noise_layer(n, rng, tilt=-1.0, lo=60, hi=600), 0.0, 0.05)
    # 晶莹高频颗粒
    for _ in range(70):
        t0 = float(rng.uniform(0, n / SR - 2.0))
        m = float(rng.choice([96, 98, 100, 103, 105, 108]))
        place(bus, synth_note(mtof(m), float(rng.uniform(0.8, 2.2)), "glass", rng, amp=1.0),
              t0, float(rng.uniform(0.015, 0.055)), pan=float(rng.uniform(-0.8, 0.8)))
    return bus, dict(wet=0.6, rt60=5.2, ir_dur=5.8, predelay=0.05, damp=9000,
                     rms_db_target=-27.0, widen=0.4, lp=15000)


def bgm_noisy_lounge(rng: np.random.Generator):
    n = loop_len(72)
    bus = _bus(n)
    # 人声嗡鸣模拟：带共振峰的噪声 + 多重慢速调制（不包含任何真人声）
    crowd = noise_layer(n, rng, tilt=-0.55, lo=140, hi=4200, bump_f=520, bump_w=0.45, bump_gain=1.6)
    crowd2 = noise_layer(n, rng, tilt=-0.55, lo=200, hi=3500, bump_f=1400, bump_w=0.4, bump_gain=1.2)
    mod = (lfo(n, 23, depth=0.35, base=0.65, phase=0.1) * lfo(n, 37, depth=0.3, base=1.0, phase=0.55)
           * lfo(n, 11, depth=0.2, base=1.0, phase=0.83))
    place(bus, (0.6 * crowd + 0.4 * crowd2).astype(np.float32) * mod, 0.0, 0.3)
    # 远处 muffled 音乐
    pad = pad_layer([50, 57, 62, 65], n, rng, harm=(1, 2, 3, 4), amps=(1, .35, .14, .06), detune=0.002)
    place(bus, pad * lfo(n, 2, depth=0.2, base=0.6), 0.0, 0.12)
    # 杯盏碰撞
    for _ in range(14):
        t0 = float(rng.uniform(0, n / SR - 1.5))
        place(bus, synth_note(mtof(float(rng.uniform(84, 96))), 0.9, "glass", rng, amp=1.0),
              t0, float(rng.uniform(0.02, 0.05)), pan=float(rng.uniform(-0.7, 0.7)))
    place(bus, noise_layer(n, rng, tilt=-1.1, lo=25, hi=180), 0.0, 0.14)
    return bus, dict(wet=0.28, rt60=2.0, ir_dur=2.6, predelay=0.018, damp=4000,
                     rms_db_target=-21.0, widen=0.4, lp=11000)


TRACKS: List[Tuple[str, Builder]] = [
    ("organ_echo", bgm_organ_echo),
    ("sanctuary_cold", bgm_sanctuary_cold),
    ("solemn_hymn", bgm_solemn_hymn),
    ("solemn_strings", bgm_solemn_strings),
    ("alarm_cold", bgm_alarm_cold),
    ("fire_and_ash", bgm_fire_and_ash),
    ("empty_silence", bgm_empty_silence),
    ("tender_solitude", bgm_tender_solitude),
    ("piano_warm", bgm_piano_warm),
    ("music_warm_box", bgm_music_warm_box),
    ("whimsical_warm", bgm_whimsical_warm),
    ("lonely_synth_rain", bgm_lonely_synth_rain),
    ("melancholy_rain", bgm_melancholy_rain),
    ("rain_and_clock", bgm_rain_and_clock),
    ("silence_snow", bgm_silence_snow),
    ("noisy_lounge", bgm_noisy_lounge),
]


# --------------------------------------------------------------------------------------
# 4 个音效
# --------------------------------------------------------------------------------------
def sfx_click(rng: np.random.Generator) -> np.ndarray:
    n = int(0.07 * SR)
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    x = rng.standard_normal(n).astype(np.float32)
    X = np.fft.rfft(x)
    f = np.maximum(np.fft.rfftfreq(n, 1.0 / SR), 1.0)
    X *= (f / (f + 1800.0)) * np.exp(-0.5 * (np.log(f / 4200.0) / 0.55) ** 2)
    x = np.fft.irfft(X, n).astype(np.float32)
    x /= float(np.max(np.abs(x)) + 1e-9)
    x *= np.exp(-t / np.float32(0.006))
    x += 0.45 * np.sin(np.float32(2 * np.pi * 1500) * t) * np.exp(-t / np.float32(0.009))
    x[:12] *= np.linspace(0, 1, 12, dtype=np.float32)
    x[-80:] *= np.linspace(1, 0, 80, dtype=np.float32)
    return x


def sfx_choice(rng: np.random.Generator) -> np.ndarray:
    n = int(0.36 * SR)
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    # 两个音的上行确认音（880 -> 1320）
    f_curve = 880.0 + (1320.0 - 880.0) * smoothstep(np.clip(t / 0.12, 0, 1))
    ph = np.cumsum((2 * np.pi * f_curve / SR).astype(np.float32)).astype(np.float32)
    tone = np.sin(ph) + 0.35 * np.sin(2.0 * ph)
    env = np.exp(-np.maximum(0.0, t - 0.03) / np.float32(0.16))
    env[:240] *= np.linspace(0, 1, 240, dtype=np.float32)
    x = (tone * env).astype(np.float32)
    # 轻微板混响
    wet = np.zeros(n, dtype=np.float32)
    for d, g in [(0.045, 0.22), (0.083, 0.14), (0.131, 0.09), (0.19, 0.05)]:
        i = int(d * SR)
        wet[i:] += x[: n - i] * np.float32(g)
    return ((x + wet) / (1.0 + 0.5)).astype(np.float32)


def sfx_page(rng: np.random.Generator) -> np.ndarray:
    n = int(0.46 * SR)
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    x = rng.standard_normal(n).astype(np.float32)
    X = np.fft.rfft(x)
    f = np.maximum(np.fft.rfftfreq(n, 1.0 / SR), 1.0)
    X *= (f / (f + 900.0)) * 1.0 / np.sqrt(1.0 + (f / 7000.0) ** 4)
    x = np.fft.irfft(X, n).astype(np.float32)
    x /= float(np.max(np.abs(x)) + 1e-9)
    # 两次翻页摩擦
    env = np.zeros(n, dtype=np.float32)
    for c, w, a in [(0.09, 0.055, 1.0), (0.26, 0.07, 0.7)]:
        idx = (np.arange(n, dtype=np.float32) / SR - c)
        env += (a * np.exp(-0.5 * (idx / w) ** 2)).astype(np.float32)
    x *= env
    x[:200] *= np.linspace(0, 1, 200, dtype=np.float32)
    x[-400:] *= np.linspace(1, 0, 400, dtype=np.float32)
    return x.astype(np.float32)


def sfx_bell(rng: np.random.Generator) -> np.ndarray:
    n = int(1.5 * SR)
    t = np.arange(n, dtype=np.float32) / np.float32(SR)
    f0 = 262.0
    # 教堂钟：非谐分音 + 双失谐拍频
    parts = [(0.5, 1.0, 3.2), (1.0, 0.85, 2.6), (1.19, 0.5, 1.9), (1.5, 0.34, 1.5),
             (2.0, 0.42, 1.3), (2.51, 0.2, 0.95), (3.01, 0.16, 0.7), (4.07, 0.1, 0.5),
             (5.43, 0.05, 0.35)]
    out = np.zeros(n, dtype=np.float32)
    for r, a, tau in parts:
        f = f0 * r
        env = np.exp(-t / np.float32(tau))
        out += np.float32(a) * env * np.sin(np.float32(2 * np.pi * f) * t +
                                           np.float32(rng.uniform(0, 6.28)))
        out += np.float32(a * 0.5) * env * np.sin(np.float32(2 * np.pi * f * 1.0015) * t +
                                                  np.float32(rng.uniform(0, 6.28)))
    # 敲击瞬态
    strike_n = int(0.02 * SR)
    st = rng.standard_normal(strike_n).astype(np.float32)
    st *= np.exp(-np.arange(strike_n, dtype=np.float32) / np.float32(0.004))
    out[:strike_n] += 0.35 * st
    out[:64] *= np.linspace(0, 1, 64, dtype=np.float32)
    out[-1200:] *= np.linspace(1, 0, 1200, dtype=np.float32)
    return out.astype(np.float32)


SFX: List[Tuple[str, Callable[[np.random.Generator], np.ndarray]]] = [
    ("click", sfx_click), ("choice", sfx_choice), ("page", sfx_page), ("bell", sfx_bell),
]


# --------------------------------------------------------------------------------------
# 编码 / 写出
# --------------------------------------------------------------------------------------
def normalize_sfx(x: np.ndarray, peak_db: float = -3.0) -> np.ndarray:
    """音效：峰值归一化 + 软限幅，单声道复制到立体声。"""
    peak = float(np.max(np.abs(x)) + 1e-9)
    x = x * np.float32((10.0 ** (peak_db / 20.0)) / peak)
    x = np.float32(0.99) * np.tanh(x / np.float32(0.99))
    stereo = np.stack([x, x], axis=1).astype(np.float32)
    return stereo


def encode_mp3(path: str, stereo: np.ndarray, bitrate: int = 128) -> int:
    if lameenc is None:
        raise RuntimeError("缺少 lameenc：pip install lameenc")
    enc = lameenc.Encoder()
    enc.set_bit_rate(bitrate)
    enc.set_in_sample_rate(SR)
    enc.set_channels(2)
    enc.set_quality(7)
    pcm = (np.clip(stereo, -1.0, 1.0) * 32767.0).astype(np.int16)
    data = enc.encode(pcm.tobytes()) + enc.flush()
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


def encode_ogg(path: str, stereo: np.ndarray) -> int:
    if sf is None:
        raise RuntimeError("缺少 soundfile：pip install soundfile")
    # 分块写入：libsndfile 一次性写长 Vorbis 缓冲会崩溃，流式写入稳定且更省内存
    with sf.SoundFile(path, "w", samplerate=SR, channels=2, format="OGG",
                      subtype="VORBIS", compression_level=0.5) as fh:
        block = 1 << 18
        for i in range(0, stereo.shape[0], block):
            fh.write(stereo[i:i + block])
    return os.path.getsize(path)


def render_one(job: Tuple[str, str, Tuple[str, ...], str, str]) -> dict:
    """子进程任务：("bgm"|"sfx", name, formats, bgm_dir, sfx_dir)"""
    kind, name, formats, bgm_dir, sfx_dir = job
    out_dirs = {"bgm": bgm_dir, "sfx": sfx_dir}
    if kind == "bgm":
        builder = dict(TRACKS)[name]
        return render_track(name, builder, out_dirs, formats)
    fn = dict(SFX)[name]
    return render_sfx(name, fn, out_dirs, formats)


def render_track(name: str, builder: Builder, out_dirs: Dict[str, str],
                 formats: Sequence[str], seed: int = 0) -> dict:
    t_start = time.time()
    rng = np.random.default_rng(zlib.crc32(name.encode("utf-8")) if seed == 0 else seed)
    dry, opts = builder(rng)
    audio = finish(dry, np.random.default_rng(1234 + len(name)), **opts)
    dur = audio.shape[0] / SR
    rms = rms_db(audio)
    peak = float(np.max(np.abs(audio)))
    info = {"name": name, "seconds": round(dur, 2), "rms_db": round(rms, 1),
            "peak": round(peak, 3), "files": {}, "bytes": {}}
    for fmt in formats:
        path = os.path.join(out_dirs["bgm"], f"{name}.{fmt}")
        size = encode_mp3(path, audio, 128) if fmt == "mp3" else encode_ogg(path, audio)
        info["files"][fmt] = os.path.relpath(path, ROOT).replace("\\", "/")
        info["bytes"][fmt] = size
    info["render_s"] = round(time.time() - t_start, 1)
    info["ok"] = True
    return info


def render_sfx(name: str, fn: Callable[[np.random.Generator], np.ndarray],
               out_dirs: Dict[str, str], formats: Sequence[str]) -> dict:
    rng = np.random.default_rng(9000 + len(name))
    x = fn(rng)
    stereo = normalize_sfx(x)
    info = {"name": name, "seconds": round(stereo.shape[0] / SR, 3),
            "peak_db": round(rms_db(stereo), 1), "files": {}, "bytes": {}}
    for fmt in formats:
        path = os.path.join(out_dirs["sfx"], f"{name}.{fmt}")
        size = encode_mp3(path, stereo, 128) if fmt == "mp3" else encode_ogg(path, stereo)
        info["files"][fmt] = os.path.relpath(path, ROOT).replace("\\", "/")
        info["bytes"][fmt] = size
    return info


# --------------------------------------------------------------------------------------
# 校验
# --------------------------------------------------------------------------------------
def verify(out_dirs: Dict[str, str], formats: Sequence[str]) -> int:
    """检查生成结果：时长、采样率、声道、大小、循环点连续性。"""
    if sf is None:
        print("需要 soundfile 才能校验：pip install soundfile")
        return 1
    bad = 0
    rows = []
    for name, _ in TRACKS:
        for fmt in formats:
            path = os.path.join(out_dirs["bgm"], f"{name}.{fmt}")
            if not os.path.exists(path):
                print(f"[缺失] {path}")
                bad += 1
                continue
            info = sf.info(path)
            size = os.path.getsize(path)
            data, _ = sf.read(path, dtype="float32", always_2d=True)
            seam = float(abs(float(data[0, 0]) - float(data[-1, 0])))
            jumps = float(np.mean(np.abs(np.diff(data[: min(len(data), 20000), 0]))))
            ratio = seam / (jumps + 1e-9)
            rows.append((name, fmt, round(info.duration, 2), info.samplerate, info.channels,
                         round(size / 1024, 0), round(seam, 5), round(ratio, 2)))
            if info.samplerate != SR or info.channels != 2:
                print(f"[格式错误] {path}: {info.samplerate}Hz {info.channels}ch")
                bad += 1
            if fmt == "mp3" and size > 1.5 * 1024 * 1024:
                print(f"[过大] {path}: {size/1024/1024:.2f} MB")
                bad += 1
            if fmt == "mp3" and not (58.0 <= info.duration <= 92.0):
                print(f"[时长异常] {path}: {info.duration:.2f}s")
                bad += 1
    print(f"{'track':<20}{'fmt':<5}{'dur':>7}{'rate':>8}{'ch':>3}{'KB':>7}{'seam':>9}{'seam/jump':>11}")
    for r in rows:
        print(f"{r[0]:<20}{r[1]:<5}{r[2]:>7}{r[3]:>8}{r[4]:>3}{r[5]:>7.0f}{r[6]:>9.5f}{r[7]:>11.2f}")
    for name, _ in SFX:
        for fmt in formats:
            path = os.path.join(out_dirs["sfx"], f"{name}.{fmt}")
            if not os.path.exists(path):
                print(f"[缺失] {path}")
                bad += 1
                continue
            info = sf.info(path)
            print(f"sfx {name:<16}{fmt:<5}{info.duration:>6.2f}s  {os.path.getsize(path)/1024:>6.1f} KB")
    print("校验结果：" + ("全部通过" if bad == 0 else f"{bad} 项问题"))
    return 0 if bad == 0 else 1


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------
def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="合成《拯救 Claude 大小姐》BGM / SFX")
    ap.add_argument("--only", default="", help="只渲染指定 BGM（逗号分隔）")
    ap.add_argument("--only-sfx", action="store_true", help="只渲染音效")
    ap.add_argument("--no-sfx", action="store_true", help="不渲染音效")
    ap.add_argument("--formats", default="mp3,ogg", help="输出格式，默认 mp3,ogg")
    ap.add_argument("--bgm-dir", default=BGM_DIR)
    ap.add_argument("--sfx-dir", default=SFX_DIR)
    ap.add_argument("--force", action="store_true", help="覆盖已存在文件")
    ap.add_argument("--jobs", type=int, default=0, help="并行进程数，默认 min(核数, 4)")
    ap.add_argument("--verify", action="store_true", help="只校验已有输出")
    ap.add_argument("--list", action="store_true", help="列出曲目")
    args = ap.parse_args(argv)

    formats = [f.strip().lower() for f in args.formats.split(",") if f.strip()]
    out_dirs = {"bgm": args.bgm_dir, "sfx": args.sfx_dir}
    os.makedirs(out_dirs["bgm"], exist_ok=True)
    os.makedirs(out_dirs["sfx"], exist_ok=True)

    if args.list:
        for i, (name, _) in enumerate(TRACKS, 1):
            print(f"{i:2d}. {name}")
        print("sfx: " + ", ".join(n for n, _ in SFX))
        return 0
    if args.verify:
        return verify(out_dirs, formats)

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    report: dict = {"generated": [], "failed": [], "skipped": [], "started": time.strftime("%Y-%m-%d %H:%M:%S")}
    t_all = time.time()

    jobs: List[Tuple[str, str, Tuple[str, ...], str, str]] = []
    if not args.only_sfx:
        for name, _ in TRACKS:
            if only and name not in only:
                continue
            existing = [os.path.join(out_dirs["bgm"], f"{name}.{fmt}") for fmt in formats]
            if not args.force and all(os.path.exists(p) for p in existing):
                print(f"[跳过] {name}（已存在）", flush=True)
                report["skipped"].append(name)
                continue
            jobs.append(("bgm", name, tuple(formats), out_dirs["bgm"], out_dirs["sfx"]))
    if not args.no_sfx and not only:
        for name, _ in SFX:
            jobs.append(("sfx", name, tuple(formats), out_dirs["bgm"], out_dirs["sfx"]))

    n_jobs = args.jobs or min(4, max(1, (os.cpu_count() or 4)))
    n_jobs = max(1, min(n_jobs, len(jobs) or 1))

    def _record(info: dict, kind: str) -> None:
        report["generated"].append(info)
        if kind == "bgm":
            print(f"[完成] {info['name']:<18} {info['seconds']:>5.1f}s "
                  f"rms {info['rms_db']:>6.1f}dB peak {info['peak']:.2f} "
                  f"{', '.join(f'{k}={v/1024:.0f}KB' for k, v in info['bytes'].items())} "
                  f"({info['render_s']}s)", flush=True)
        else:
            print(f"[完成] sfx/{info['name']:<14} {info['seconds']:>5.2f}s "
                  f"{', '.join(f'{k}={v/1024:.1f}KB' for k, v in info['bytes'].items())}", flush=True)

    if n_jobs > 1 and len(jobs) > 1:
        import multiprocessing as mp
        print(f"并行渲染 {len(jobs)} 个任务（{n_jobs} 进程）...", flush=True)
        with mp.Pool(processes=n_jobs) as pool:
            for info in pool.imap_unordered(render_one, jobs):
                _record(info, "sfx" if info["name"] in dict(SFX) else "bgm")
    else:
        for job in jobs:
            try:
                _record(render_one(job), job[0])
            except Exception as exc:  # noqa: BLE001
                report["failed"].append({"name": job[1], "error": repr(exc)})
                print(f"[失败] {job[1]}: {exc!r}", flush=True)

    report["elapsed_s"] = round(time.time() - t_all, 1)
    total = sum(sum(i["bytes"].values()) for i in report["generated"])
    report["total_bytes"] = total
    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"\n已生成 {len(report['generated'])} 个文件，失败 {len(report['failed'])}，"
          f"跳过 {len(report['skipped'])}，合计 {total/1024/1024:.2f} MB，耗时 {report['elapsed_s']}s")
    return 0 if not report["failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
