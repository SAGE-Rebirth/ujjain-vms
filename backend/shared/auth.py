"""
Authentication primitives shared by central + checkpoint.

Two token kinds, both stateless and HMAC-signed with a server secret (so no
session table is needed and verification is O(1)):
  * STAFF tokens  — carry {sub, role, name}; minted at /api/auth/login.
  * CITIZEN tokens — carry {sub: phone, role: 'citizen'}; minted after OTP verify.

Passwords use PBKDF2-HMAC-SHA256 with a per-user salt. The server secret lives
next to the Ed25519 keys (keys/), generated on first run; it NEVER leaves central.

This is prototype-grade but real: signed tokens, salted password hashing, expiry.
Production would swap in an IdP / mTLS for node↔central and Aadhaar-eKYC for citizens
(see docs/AUDIT.md), but the shape — role-bound bearer tokens — stays the same.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path

KEYS_DIR = Path(__file__).resolve().parents[2] / "keys"
SECRET_PATH = KEYS_DIR / "session_secret"

_PBKDF2_ROUNDS = 120_000


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_dec(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def ensure_secret() -> None:
    KEYS_DIR.mkdir(parents=True, exist_ok=True)
    if not SECRET_PATH.exists():
        SECRET_PATH.write_bytes(os.urandom(32))


def _secret() -> bytes:
    ensure_secret()
    return SECRET_PATH.read_bytes()


# --------------------------------------------------------------------------- #
# Passwords
# --------------------------------------------------------------------------- #
def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """Return (hash_hex, salt_hex). Generates a salt if not given."""
    salt_b = bytes.fromhex(salt) if salt else os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt_b, _PBKDF2_ROUNDS)
    return dk.hex(), salt_b.hex()


def verify_password(password: str, hash_hex: str, salt_hex: str) -> bool:
    calc, _ = hash_password(password, salt_hex)
    return hmac.compare_digest(calc, hash_hex)


# --------------------------------------------------------------------------- #
# Tokens
# --------------------------------------------------------------------------- #
def make_token(payload: dict, ttl_seconds: int = 8 * 3600) -> str:
    body = dict(payload)
    body["exp"] = int(datetime.now(timezone.utc).timestamp()) + ttl_seconds
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    sig = hmac.new(_secret(), raw, hashlib.sha256).digest()
    return f"{_b64u(raw)}.{_b64u(sig)}"


def verify_token(token: str | None) -> dict | None:
    """Return the payload if the signature is valid and unexpired, else None."""
    if not token:
        return None
    try:
        body_b64, sig_b64 = token.split(".", 1)
        raw = _b64u_dec(body_b64)
        expected = hmac.new(_secret(), raw, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64u_dec(sig_b64)):
            return None
        payload = json.loads(raw)
    except (ValueError, KeyError, json.JSONDecodeError):
        return None
    if payload.get("exp", 0) < int(datetime.now(timezone.utc).timestamp()):
        return None
    return payload


def bearer(authorization: str | None) -> str | None:
    """Extract the token from an 'Authorization: Bearer <t>' header value."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None
