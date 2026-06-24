"""
Offline-verifiable ticket signing/verification.

Trust model (Section 6 of the brief): the central server signs every booking
ticket with an Ed25519 PRIVATE key at issuance time. Each checkpoint node holds
only the PUBLIC key, baked in at provisioning, and can therefore verify a ticket's
authenticity with ZERO network access — exactly like an offline boarding-pass scan.

Token format (compact, self-contained):
    base64url(payload_json) + "." + base64url(signature)

The payload carries everything a checkpoint needs to decide admit/deny offline:
booking id, zone, slot window, vehicle type. A short human-typeable code is also
derived so an operator can admit a vehicle even if the QR scan fails.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

KEYS_DIR = Path(__file__).resolve().parents[2] / "keys"
PRIVATE_KEY_PATH = KEYS_DIR / "central_ed25519.priv"
PUBLIC_KEY_PATH = KEYS_DIR / "central_ed25519.pub"
# Secret keying the plate HMAC. Lets the QR carry a *hash* of the plate instead of
# cleartext (privacy / DPDP, docs/AUDIT.md C8) while an authenticated gate can still
# verify an observed plate offline. Distributed only to authenticated nodes at sync.
PLATE_SECRET_PATH = KEYS_DIR / "plate_secret"

# Payload schema version + signing key id. `kid` lets a node hold several public
# keys and lets us rotate the central key WITHOUT re-provisioning every node at
# once (see docs/DESIGN-v2.md §4). Only one key exists today; the field is here
# for forward compatibility so v2 tickets never need a breaking re-issue.
PAYLOAD_VERSION = 2
KEY_ID = "central-1"

# Crockford-ish base32 alphabet (no I/L/O/U to avoid human confusion).
_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def normalize_plate(plate: str | None) -> str:
    """Canonical plate form for binding + comparison: upper, alphanumeric only.

    'mp 09 ab 1234' / 'MP09-AB-1234' / 'mp09ab1234' all collapse to 'MP09AB1234'
    so an operator's spacing/hyphen choice never causes a false plate mismatch.
    """
    if not plate:
        return ""
    return "".join(ch for ch in plate.upper() if ch.isalnum())


def ensure_plate_secret() -> None:
    KEYS_DIR.mkdir(parents=True, exist_ok=True)
    if not PLATE_SECRET_PATH.exists():
        import os
        PLATE_SECRET_PATH.write_bytes(os.urandom(32))


def plate_secret_b64() -> str:
    ensure_plate_secret()
    return base64.b64encode(PLATE_SECRET_PATH.read_bytes()).decode("ascii")


def plate_hash(plate: str, secret_b64: str | None = None) -> str:
    """Keyed HMAC of the normalized plate (privacy-preserving binding). Truncated —
    16 hex chars is ample to bind one vehicle, and a QR-reader without the secret
    can't recover the plate (HMAC defeats brute force over low-entropy plates)."""
    import hashlib
    import hmac
    if secret_b64:
        secret = base64.b64decode(secret_b64)
    else:
        ensure_plate_secret()
        secret = PLATE_SECRET_PATH.read_bytes()
    return hmac.new(secret, normalize_plate(plate).encode(), hashlib.sha256).hexdigest()[:16]


def plate_last4(plate: str) -> str:
    """Last 4 chars — shown to the operator when the full plate isn't cached yet."""
    return normalize_plate(plate)[-4:]


def _b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def ensure_keys() -> None:
    """Generate the central keypair on first run. Idempotent."""
    KEYS_DIR.mkdir(parents=True, exist_ok=True)
    if PRIVATE_KEY_PATH.exists() and PUBLIC_KEY_PATH.exists():
        return
    priv = Ed25519PrivateKey.generate()
    PRIVATE_KEY_PATH.write_bytes(
        priv.private_bytes_raw()  # 32 raw bytes
    )
    PUBLIC_KEY_PATH.write_bytes(priv.public_key().public_bytes_raw())


def load_private_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(PRIVATE_KEY_PATH.read_bytes())


def load_public_key() -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(PUBLIC_KEY_PATH.read_bytes())


def _canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def human_code(booking_id: str) -> str:
    """6-char operator-typeable fallback code, deterministic from booking id."""
    digest = hashlib.sha256(booking_id.encode("utf-8")).digest()
    num = int.from_bytes(digest[:5], "big")
    chars = []
    for _ in range(6):
        chars.append(_CODE_ALPHABET[num % 32])
        num //= 32
    return "".join(reversed(chars))


def sign_ticket(payload: dict) -> str:
    """Return a signed token string for the given payload dict."""
    priv = load_private_key()
    body = _canonical(payload)
    sig = priv.sign(body)
    return f"{_b64u_encode(body)}.{_b64u_encode(sig)}"


def verify_ticket(token: str, public_key: Ed25519PublicKey | None = None) -> dict:
    """
    Verify token signature OFFLINE. Returns the payload dict.
    Raises ValueError if malformed or signature invalid.
    """
    pub = public_key or load_public_key()
    try:
        body_b64, sig_b64 = token.split(".", 1)
    except ValueError as exc:
        raise ValueError("malformed token") from exc
    body = _b64u_decode(body_b64)
    sig = _b64u_decode(sig_b64)
    try:
        pub.verify(sig, body)
    except InvalidSignature as exc:
        raise ValueError("bad signature") from exc
    return json.loads(body)
