"""Template -> one row. Text is built as pieces so span offsets are exact by construction.

Slot grammar in a template: {{type}}, {{type#2}} (a second distinct value), {{type:variant}}.
  PII id types (values.MAKERS keys): a valid value; variants invalid / masked (clean templates only).
  au-name us-name au-address us-address au-dob us-dob email: PII text with a span.
  secret:aws|github|stripe|slack|jwt|password|conn: a credential, span type "secret".
  staff-name company date amount ref:PREFIX num:N: no span (num:N never passes an ID checksum).
"""
import random
import re
import string

import names
import values

SLOT = re.compile(r"\{\{([a-z0-9-]+)(?:#(\d+))?(?::([A-Za-z0-9_-]+))?\}\}")

SPAN_ONLY_PII = {"au-name", "us-name", "au-address", "us-address", "au-dob", "us-dob", "email"}
SECRET_KINDS = ("aws", "github", "stripe", "slack", "jwt", "password", "conn")
NO_SPAN = {"staff-name", "company", "date", "amount", "ref", "num"}
JURISDICTION = {"au": "AU", "us": "US"}


def jur(typ):
    return JURISDICTION.get(typ.split("-")[0], "none")


def b62(rng, n):
    return "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(n))


def make_secret(kind, rng):
    if kind == "aws":
        return "AKIA" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(16))
    if kind == "github":
        return "ghp_" + b62(rng, 36)
    if kind == "stripe":
        return rng.choice(("sk_live_", "rk_live_")) + b62(rng, 24)
    if kind == "slack":
        return f"xoxb-{rng.randint(10**11, 10**12 - 1)}-{rng.randint(10**11, 10**12 - 1)}-{b62(rng, 24)}"
    if kind == "jwt":
        return f"eyJ{b62(rng, 17)}.eyJ{b62(rng, 38)}.{b62(rng, 43)}"
    if kind == "password":
        return rng.choice(("Summer", "Winter", "Harbour", "Falcon", "Granite")) + str(rng.randint(10, 99)) + rng.choice("!#$%") + b62(rng, 5)
    if kind == "conn":
        return f"postgres://svc_app:{b62(rng, 14)}@db-{rng.randint(1, 9)}.internal.example:5432/prod"
    raise ValueError(f"unknown secret kind {kind}")


def non_id_number(rng, n):
    """n random digits that fail every digit-string validator we ship."""
    for _ in range(100000):
        s = values.digits(rng, n)
        if not values.looks_like_other_id("", s):
            return s
    raise ValueError(f"no {n}-digit non-ID number found")


def heavy_mask(canon, keep=4):
    digs = [i for i, c in enumerate(canon) if c.isalnum()]
    cut = set(digs[:-keep]) if keep else set(digs)
    return "".join("*" if i in cut else c for i, c in enumerate(canon))


def style_value(canon, rng, level):
    """Surface variants of a valid value. level 0 plain; 1 separator change; 2 hard (spread, light mask, wrapped)."""
    if level == 0:
        return canon, 0
    r = rng.random()
    if level == 1 or r < 0.5:
        alt = rng.choice(("compact", "dashed", "dotted", "slashed"))
        if alt == "compact":
            return canon.replace(" ", "").replace("-", "").replace(".", ""), 1
        if alt == "dashed":
            return canon.replace(" ", "-").replace(".", "-"), 1
        if alt == "dotted":
            return canon.replace(" ", ".").replace("-", "."), 1
        return canon.replace(" ", "/") if " " in canon else canon, 1
    alt = rng.choice(("spread", "wrapped"))
    digs = [i for i, c in enumerate(canon) if c.isdigit()]
    if alt == "spread" and len(digs) >= 8 and not any(c.isalpha() for c in canon):
        return " ".join(c for c in canon if c.isalnum()), 2
    if alt == "wrapped" and " " in canon:
        i = canon.index(" ", len(canon) // 2) if " " in canon[len(canon) // 2:] else canon.index(" ")
        return canon[:i] + "\n" + canon[i + 1:], 2
    return canon.replace(" ", ""), 1


CODE_CHARS = re.compile(r"[{};=<>\\\[\]]")
AGE_RE = re.compile(r"\baged? (\d{1,2})\b|\b(\d{1,2})[- ]year[- ]old|\b(\d{1,2}) years old", re.I)
CHILD_RE = re.compile(r"\b(child|children|kid|kids|toddler|infant|baby|primary school|kindergarten|preschool|grade \d+|year \d{1,2} (student|class|school|pupil))\b", re.I)
ELDER_RE = re.compile(r"dementia|aged care|resident|pension|retire|geriatric|nursing home|palliative|hospice", re.I)


def dob_years(text):
    """Birth-year range that fits the template: explicit age, child words, or adult."""
    m = AGE_RE.search(text)
    if m:
        age = int(next(g for g in m.groups() if g))
        return (2026 - age - 1, 2026 - age)
    if CHILD_RE.search(text):
        return (2008, 2019)
    if ELDER_RE.search(text):
        return (1930, 1952)
    return None


FEM_RE = re.compile(r"\b(she|her|hers|herself)\b", re.I)
MASC_RE = re.compile(r"\b(he|his|him|himself)\b", re.I)


KEYB = {"a": "sq", "e": "wr", "i": "uo", "o": "ip", "u": "yi", "n": "bm", "t": "ry", "s": "ad", "r": "et", "l": "k", "h": "gj", "c": "xv"}


def typo(s, rng, n):
    cs = list(s)
    idx = [i for i, c in enumerate(cs) if c.isalpha() and (i == 0 or cs[i - 1].isalpha())]
    rng.shuffle(idx)
    for i in sorted(idx[:n], reverse=True):
        c = cs[i].lower()
        r = rng.random()
        if r < 0.4 and c in KEYB:
            cs[i] = rng.choice(KEYB[c])
        elif r < 0.7 and i + 1 < len(cs):
            cs[i], cs[i + 1] = cs[i + 1], cs[i]
        else:
            del cs[i]
    return "".join(cs)


class Piece:
    __slots__ = ("text", "span", "lookalike")

    def __init__(self, text, span=None, lookalike=None):
        self.text, self.span, self.lookalike = text, span, lookalike


def parse(text):
    out, pos = [], 0
    for m in SLOT.finditer(text):
        if m.start() > pos:
            out.append(("lit", text[pos:m.start()]))
        out.append(("slot", m.group(1), m.group(2) or "", m.group(3) or ""))
        pos = m.end()
    if pos < len(text):
        out.append(("lit", text[pos:]))
    return out


def resolve(typ, idx, variant, rng, label, cache, level, hardness, ctx=""):
    """Return (display, span_or_None, lookalike_or_None). cache keeps {{x}} stable within a row."""
    key = (typ, idx, variant)
    if key in cache:
        canon, valid = cache[key]
    else:
        canon, valid = _fresh(typ, variant, rng, label, cache, ctx)
        cache[key] = (canon, valid)
    j = jur(typ)
    if typ in values.MAKERS:
        if variant == "invalid":
            return style_value(canon, rng, 1 if level else 0)[0], None, {"type": typ}
        if variant == "masked":
            return heavy_mask(canon), None, {"type": typ}
        shown, lv = style_value(canon, rng, level)
        hardness[0] = max(hardness[0], lv)
        return shown, {"type": typ, "jurisdiction": j, "value_valid": True}, None
    if typ in SPAN_ONLY_PII:
        shown = canon.upper() if typ.endswith("name") and level == 2 and rng.random() < 0.3 else canon
        return shown, {"type": typ, "jurisdiction": j, "value_valid": True}, None
    if typ == "secret":
        return canon, {"type": "secret", "jurisdiction": "none", "value_valid": True}, None
    return canon, None, None


def _fresh(typ, variant, rng, label, cache, ctx=""):
    if typ == "au-phone" and variant == "":
        kind = "mobile" if re.search(r"mobile|\bmob\b|cell|sms|text", ctx[-60:], re.I) else "landline" if re.search(r"landline|office|desk|home phone|switchboard|reception", ctx[-60:], re.I) else None
        return values.make_au_phone(rng, kind), True
    if typ in values.MAKERS:
        if variant == "invalid":
            v, ok = values.make(typ, rng, valid=False)
            return v, ok
        return values.make(typ, rng)[0], True
    if typ == "au-name" or typ == "us-name" or typ == "staff-name":
        who = names.person(rng, cache.get("__sex"))
        cache["__who"] = who
        return names.full_name(rng, who), True
    if typ == "au-address":
        return names.au_address(rng, cache.get("__ahint_au")), True
    if typ == "us-address":
        return names.us_address(rng, cache.get("__ahint_us")), True
    if typ == "au-dob":
        return names.dob(rng, "AU", cache.get("__dob")), True
    if typ == "us-dob":
        return names.dob(rng, "US", cache.get("__dob")), True
    if typ == "email":
        return names.email(rng, "none", cache.get("__who")), True
    if typ == "secret":
        if variant not in SECRET_KINDS:
            raise ValueError(f"secret needs a kind: {SECRET_KINDS}")
        return make_secret(variant, rng), True
    if typ == "company":
        return names.company(rng, "US" if variant == "us" else "AU"), True
    if typ == "date":
        d = names.plain_date(rng, "US" if variant == "us" else "AU", cache.get("__date"))
        cache["__date"] = d[1]
        return d[0], True
    if typ == "amount":
        return names.amount(rng, "US" if variant == "us" else "AU", names.amount_scale(ctx)), True
    if typ == "ref":
        return names.ref(rng, variant or "REF"), True
    if typ == "num":
        return non_id_number(rng, int(variant or 9)), True
    raise ValueError(f"unknown slot type {typ}")


def check_template(t):
    """Raise ValueError on a template the generator cannot render. Returns the slot list."""
    slots = []
    for p in parse(t["text"]):
        if p[0] != "slot":
            continue
        typ, _, variant = p[1], p[2], p[3]
        slots.append((typ, variant))
        if typ in values.MAKERS:
            if t["label"] == "clean" and variant == "":
                raise ValueError(f"valid {typ} in a clean template")
            if variant in ("invalid", "masked") and t["label"] != "clean":
                raise ValueError(f"{typ}:{variant} only in clean templates")
            if variant == "invalid" and typ not in values.CHECKSUM_TYPES:
                raise ValueError(f"{typ} has no checksum for :invalid")
            if variant not in ("", "invalid", "masked"):
                raise ValueError(f"bad variant {variant} on {typ}")
        elif typ == "secret":
            if variant not in SECRET_KINDS:
                raise ValueError("secret needs a kind")
            if t["label"] == "clean":
                raise ValueError("secret slot in a clean template")
        elif typ in SPAN_ONLY_PII:
            if t["label"] == "clean":
                raise ValueError(f"{typ} in a clean template: use staff-name or a lookalike")
        elif typ not in NO_SPAN:
            raise ValueError(f"unknown slot type {typ}")
    if t["label"] == "violation" and not t.get("categories"):
        raise ValueError("violation needs categories")
    return slots


FILLER = (
    "Please keep the tone professional.",
    "I need this by end of day.",
    "Sorry for the mess, I pasted this straight from our system.",
    "Let me know if anything looks off.",
)

SHELLS = (
    ("", ""),
    ("", "\n\nThanks!"),
    ("Hi, quick one.\n\n", ""),
    ("Can you help with this?\n\n", "\n\nThanks."),
    ("```\n", "\n```"),
    ("From: ops@example.com\nTo: team@example.com\nSubject: FW: please review\n\n", "\n\nRegards"),
    ("User pasted:\n---\n", "\n---"),
    ("> ", ""),
)


def render_row(t, rng):
    """Render template t once. Returns a dict of row fields (no id/split) or None if the template cannot render."""
    level = rng.choices((0, 1, 2), weights=(55, 30, 15))[0] if t["label"] == "violation" else rng.choices((0, 1), weights=(70, 30))[0]
    hardness = [0]
    cache = {}
    pieces = []
    shell = rng.choice(SHELLS) if t["shape"] != "oneliner" else ("", "")
    if shell[0]:
        pieces.append(Piece(shell[0]))
    do_typo = rng.random() < 0.15 and not CODE_CHARS.search(SLOT.sub("", t["text"]))
    cache["__dob"] = dob_years(t["text"])
    she, he = FEM_RE.search(t["text"]), MASC_RE.search(t["text"])
    cache["__sex"] = "F" if she and not he else "M" if he and not she else None
    cache["__ahint_au"] = names.state_hint(t["text"] + " " + t["description"], names.AU_HINTS, names.AU_SUBURBS)
    cache["__ahint_us"] = names.state_hint(t["text"] + " " + t["description"], names.US_HINTS, names.US_CITIES)
    if t["shape"] == "document" and rng.random() < 0.4:
        filler = rng.choice(FILLER)
        pieces.append(Piece(filler + "\n\n"))
    ctx = ""
    parts = parse(t["text"])
    for i, p in enumerate(parts):
        if p[0] == "lit":
            ctx = p[1]
            s = typo(p[1], rng, rng.randint(1, 2)) if do_typo else p[1]
            pieces.append(Piece(s))
        else:
            after = parts[i + 1][1][:40] if i + 1 < len(parts) and parts[i + 1][0] == "lit" else ""
            disp, span, look = resolve(p[1], p[2], p[3], rng, t["label"], cache, level, hardness, ctx[-90:] + " " + after)
            pieces.append(Piece(disp, span, look))
    if shell[1]:
        pieces.append(Piece(shell[1]))
    prompt, spans, looks, pos = [], [], [], 0
    for pc in pieces:
        prompt.append(pc.text)
        if pc.span:
            spans.append({"start": pos, "end": pos + len(pc.text), **pc.span})
        if pc.lookalike:
            looks.append({"start": pos, "end": pos + len(pc.text), **pc.lookalike})
        pos += len(pc.text)
    cats = list(t["categories"])
    for s in spans:
        if s["type"] not in cats:
            cats.append(s["type"])
    diff = t["difficulty"]
    if hardness[0] == 2 or (do_typo and diff == "easy"):
        diff = "hard" if hardness[0] == 2 else "medium"
    return {
        "industry": t["industry"], "role": t["role"], "description": t["description"].replace("{role}", t["role"]),
        "prompt": "".join(prompt), "row_label": t["label"], "categories": cats, "spans": spans, "lookalikes": looks,
        "policy_basis": t["policy_basis"], "difficulty": diff, "template_family_id": t["family_id"], "shape": t["shape"],
        "jurisdiction": t["jurisdiction"],
    }
