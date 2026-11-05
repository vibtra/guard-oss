"""Synthetic ID values. Every maker returns a canonical display string; every validator is independent
of its maker so checks.py can verify value_valid without trusting the generator."""
import string

DIGITS = string.digits
UP = string.ascii_uppercase


def digits(rng, n):
    return "".join(rng.choice(DIGITS) for _ in range(n))


def luhn_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    if len(d) < 2:
        return False
    t = 0
    for i, v in enumerate(reversed(d)):
        if i % 2:
            v *= 2
            if v > 9:
                v -= 9
        t += v
    return t % 10 == 0


def luhn_check_digit(body):
    for c in DIGITS:
        if luhn_ok(body + c):
            return c


def tfn_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    w9 = [1, 4, 3, 7, 5, 8, 6, 9, 10]
    w8 = [10, 7, 8, 4, 6, 3, 5, 1]
    if len(d) == 9:
        return sum(a * b for a, b in zip(d, w9)) % 11 == 0
    if len(d) == 8:
        return sum(a * b for a, b in zip(d, w8)) % 11 == 0
    return False


def make_tfn(rng):
    w = [1, 4, 3, 7, 5, 8, 6, 9]
    while True:
        d = [rng.randint(0, 9) for _ in range(8)]
        d[0] = rng.randint(1, 9)
        s = sum(a * b for a, b in zip(d, w))
        last = s % 11
        if last < 10:
            d.append(last)
            t = "".join(map(str, d))
            return f"{t[:3]} {t[3:6]} {t[6:]}"


def medicare_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    if len(d) not in (10, 11) or not 2 <= d[0] <= 6:
        return False
    if d[9] == 0:
        return False
    return sum(a * b for a, b in zip(d[:8], [1, 3, 7, 9, 1, 3, 7, 9])) % 10 == d[8]


def make_medicare(rng):
    d = [rng.randint(2, 6)] + [rng.randint(0, 9) for _ in range(7)]
    chk = sum(a * b for a, b in zip(d, [1, 3, 7, 9, 1, 3, 7, 9])) % 10
    t = "".join(map(str, d)) + str(chk) + str(rng.randint(1, 9))
    s = f"{t[:4]} {t[4:9]} {t[9]}"
    if rng.random() < 0.5:
        s += f" {rng.randint(1, 9)}"
    return s


def abn_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    if len(d) != 11 or d[0] == 0:
        return False
    d[0] -= 1
    return sum(a * b for a, b in zip(d, [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19])) % 89 == 0


def make_abn(rng):
    while True:
        tail = digits(rng, 9)
        opts = [f"{p}{tail}" for p in range(10, 100) if abn_ok(f"{p}{tail}")]
        if opts:
            t = rng.choice(opts)
            return f"{t[:2]} {t[2:5]} {t[5:8]} {t[8:]}"


def acn_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    if len(d) != 9:
        return False
    return (10 - sum(a * b for a, b in zip(d[:8], range(8, 0, -1))) % 10) % 10 == d[8]


def make_acn(rng):
    d = [rng.randint(0, 9) for _ in range(8)]
    chk = (10 - sum(a * b for a, b in zip(d, range(8, 0, -1))) % 10) % 10
    t = "".join(map(str, d)) + str(chk)
    return f"{t[:3]} {t[3:6]} {t[6:]}"


def ihi_ok(s):
    d = "".join(c for c in s if c.isdigit())
    return len(d) == 16 and d.startswith("800360") and luhn_ok(d)


def make_ihi(rng):
    body = "800360" + digits(rng, 9)
    t = body + luhn_check_digit(body)
    return " ".join(t[i:i + 4] for i in range(0, 16, 4))


AU_DL_STATES = ("NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT")
AU_DL_RE_LEN = {"NSW": (8, 8), "VIC": (8, 10), "QLD": (8, 9), "WA": (7, 7), "SA": (6, 6), "TAS": (7, 7), "ACT": (6, 10), "NT": (5, 7)}


def make_au_dl(rng, state=None):
    state = state or rng.choice(AU_DL_STATES)
    if state == "NSW":
        return digits(rng, 2) + rng.choice(UP) + digits(rng, 5)
    if state == "SA":
        return rng.choice(UP) + digits(rng, 5)
    if state == "TAS":
        return rng.choice(UP) + digits(rng, 6)
    lo, hi = AU_DL_RE_LEN[state]
    return digits(rng, rng.randint(lo, hi))


def au_dl_ok(s, state=None):
    s = s.replace(" ", "")
    if not s.isalnum():
        return False
    states = [state] if state else AU_DL_STATES
    for st in states:
        lo, hi = AU_DL_RE_LEN[st]
        if lo <= len(s) <= hi:
            return True
    return False


def make_au_passport(rng):
    return rng.choice("NPEMLRBCDF") + digits(rng, 7)


def au_passport_ok(s):
    s = s.replace(" ", "")
    return len(s) == 8 and s[0].isalpha() and s[1:].isdigit()


BSB_PREFIX = ("012", "032", "033", "062", "063", "065", "082", "083", "084", "112", "182", "212", "302", "306", "484", "513", "733", "803")


def make_au_bsb(rng):
    p = rng.choice(BSB_PREFIX)
    return f"{p}-{digits(rng, 3)}"


def au_bsb_ok(s):
    d = [c for c in s if c.isdigit()]
    return len(d) == 6 and "".join(d[:3]) in BSB_PREFIX


def make_au_acct(rng):
    return digits(rng, rng.randint(6, 10))


def make_au_crn(rng):
    return digits(rng, 9) + rng.choice(UP)


def au_crn_ok(s):
    s = s.replace(" ", "")
    return len(s) == 10 and s[:9].isdigit() and s[9].isalpha()


AU_MOBILE_FICT = ("0491 570", "0491 571", "0491 572")


def make_au_phone(rng, kind=None):
    r = rng.random()
    if kind == "mobile" or (kind is None and r < 0.75):
        pre = rng.choice(AU_MOBILE_FICT)
        return f"{pre} {digits(rng, 3)}"
    area = rng.choice("2378")
    if rng.random() < 0.5:
        return f"(0{area}) 5550 {digits(rng, 4)}"
    return f"0{area} 5550 {digits(rng, 4)}"


def au_phone_ok(s):
    d = "".join(c for c in s if c.isdigit())
    return len(d) == 10 and d[0] == "0" and d[1] in "2345678"


def ssn_ok(s):
    d = "".join(c for c in s if c.isdigit())
    if len(d) != 9:
        return False
    a, g, r = int(d[:3]), int(d[3:5]), int(d[5:])
    return 1 <= a <= 899 and a != 666 and g != 0 and r != 0


def make_ssn(rng):
    while True:
        a = rng.randint(1, 899)
        if a == 666:
            continue
        return f"{a:03d}-{rng.randint(1, 99):02d}-{rng.randint(1, 9999):04d}"


ITIN_MID = list(range(50, 66)) + list(range(70, 89)) + list(range(90, 93)) + list(range(94, 100))


def itin_ok(s):
    d = "".join(c for c in s if c.isdigit())
    return len(d) == 9 and d[0] == "9" and int(d[3:5]) in ITIN_MID


def make_itin(rng):
    return f"9{digits(rng, 2)}-{rng.choice(ITIN_MID):02d}-{digits(rng, 4)}"


EIN_PREFIX = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 71, 72, 73, 74, 75, 76, 77, 80, 81, 82, 83, 84, 85, 86, 87, 88, 90, 91, 92, 93, 94, 95, 98, 99]


def ein_ok(s):
    d = "".join(c for c in s if c.isdigit())
    return len(d) == 9 and int(d[:2]) in EIN_PREFIX


def make_ein(rng):
    return f"{rng.choice(EIN_PREFIX):02d}-{digits(rng, 7)}"


def aba_ok(s):
    d = [int(c) for c in s if c.isdigit()]
    if len(d) != 9:
        return False
    p = int("".join(map(str, d[:2])))
    if not (1 <= p <= 12 or 21 <= p <= 32 or 61 <= p <= 72 or p == 80):
        return False
    return sum(a * b for a, b in zip(d, [3, 7, 1] * 3)) % 10 == 0


def make_aba(rng):
    while True:
        p = rng.choice(list(range(1, 13)) + list(range(21, 33)))
        body = f"{p:02d}" + digits(rng, 6)
        d = [int(c) for c in body]
        s = sum(a * b for a, b in zip(d, [3, 7, 1, 3, 7, 1, 3, 7]))
        chk = (10 - s % 10) % 10
        t = body + str(chk)
        if aba_ok(t):
            return t


def make_us_acct(rng):
    return digits(rng, rng.randint(8, 12))


CARD_PREFIX = (("4", 16), ("51", 16), ("52", 16), ("53", 16), ("54", 16), ("55", 16), ("2221", 16), ("34", 15), ("37", 15), ("6011", 16))


def card_ok(s):
    d = "".join(c for c in s if c.isdigit())
    if not 13 <= len(d) <= 19 or not luhn_ok(d):
        return False
    return d[0] in "2345" or d.startswith("6011")


def make_card(rng):
    p, n = rng.choice(CARD_PREFIX)
    body = p + digits(rng, n - 1 - len(p))
    t = body + luhn_check_digit(body)
    if n == 15:
        return f"{t[:4]} {t[4:10]} {t[10:]}"
    return " ".join(t[i:i + 4] for i in range(0, 16, 4))


MBI_L = "ACDEFGHJKMNPQRTUVWXY"
MBI_AN = MBI_L + DIGITS


def make_mbi(rng):
    t = (str(rng.randint(1, 9)) + rng.choice(MBI_L) + rng.choice(MBI_AN) + rng.choice(DIGITS)
         + rng.choice(MBI_L) + rng.choice(MBI_AN) + rng.choice(DIGITS) + rng.choice(MBI_L) + rng.choice(MBI_L)
         + rng.choice(DIGITS) + rng.choice(DIGITS))
    return f"{t[:4]}-{t[4:7]}-{t[7:]}"


def mbi_ok(s):
    t = s.replace("-", "").replace(" ", "")
    if len(t) != 11:
        return False
    kinds = "C", "L", "A", "N", "L", "A", "N", "L", "L", "N", "N"
    for ch, k in zip(t, kinds):
        if k == "C" and ch not in "123456789":
            return False
        if k == "L" and ch not in MBI_L:
            return False
        if k == "A" and ch not in MBI_AN:
            return False
        if k == "N" and ch not in DIGITS:
            return False
    return True


def npi_ok(s):
    d = "".join(c for c in s if c.isdigit())
    return len(d) == 10 and d[0] in "12" and luhn_ok("80840" + d)


def make_npi(rng):
    while True:
        body = rng.choice("12") + digits(rng, 8)
        c = luhn_check_digit("80840" + body)
        t = body + c
        if npi_ok(t):
            return t


US_DL = {
    "CA": lambda r: r.choice(UP) + digits(r, 7),
    "NY": lambda r: digits(r, 9),
    "TX": lambda r: digits(r, 8),
    "FL": lambda r: r.choice(UP) + digits(r, 12),
    "IL": lambda r: r.choice(UP) + digits(r, 11),
    "WA": lambda r: "".join(r.choice(UP + DIGITS) for _ in range(12)),
}


def make_us_dl(rng, state=None):
    state = state or rng.choice(list(US_DL))
    v = US_DL[state](rng)
    if state == "FL":
        return f"{v[0]}{v[1:4]}-{v[4:7]}-{v[7:9]}-{v[9:12]}-{v[12]}"
    return v


def us_dl_ok(s):
    t = s.replace("-", "").replace(" ", "")
    if not t.isalnum():
        return False
    letter_digits = t[0].isalpha() and t[1:].isdigit() and len(t) in (8, 12, 13)
    return letter_digits or (t.isdigit() and len(t) in (8, 9)) or len(t) == 12


def make_us_passport(rng):
    if rng.random() < 0.7:
        return digits(rng, 9)
    return rng.choice(UP) + digits(rng, 8)


def us_passport_ok(s):
    t = s.replace(" ", "")
    return (len(t) == 9 and t.isdigit()) or (len(t) == 9 and t[0].isalpha() and t[1:].isdigit())


def make_us_phone(rng):
    a = f"{rng.randint(2, 9)}{digits(rng, 2)}"
    if a[1:] == "11":
        a = "212"
    line = f"01{digits(rng, 2)}"
    return rng.choice((f"({a}) 555-{line}", f"{a}-555-{line}", f"{a}.555.{line}"))


def us_phone_ok(s):
    d = "".join(c for c in s if c.isdigit())
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    return len(d) == 10 and d[0] in "23456789" and d[3] in "23456789"


def always_ok(_):
    return True


VALIDATORS = {
    "au-tfn": tfn_ok, "au-medicare": medicare_ok, "au-abn": abn_ok, "au-acn": acn_ok, "au-ihi": ihi_ok,
    "au-driver-licence": au_dl_ok, "au-passport": au_passport_ok, "au-bsb": au_bsb_ok, "au-crn": au_crn_ok,
    "au-phone": au_phone_ok, "us-ssn": ssn_ok, "us-itin": itin_ok, "us-ein": ein_ok, "us-routing": aba_ok,
    "us-card": card_ok, "us-mbi": mbi_ok, "us-npi": npi_ok, "us-driver-licence": us_dl_ok,
    "us-passport": us_passport_ok, "us-phone": us_phone_ok,
}

CHECKSUM_TYPES = {"us-ssn", "au-tfn", "au-medicare", "au-abn", "au-acn", "au-ihi", "us-itin", "us-ein", "us-routing", "us-card", "us-mbi", "us-npi"}

MAKERS = {
    "au-tfn": make_tfn, "au-medicare": make_medicare, "au-abn": make_abn, "au-acn": make_acn, "au-ihi": make_ihi,
    "au-driver-licence": make_au_dl, "au-passport": make_au_passport, "au-bsb": make_au_bsb, "au-account": make_au_acct,
    "au-crn": make_au_crn, "au-phone": make_au_phone, "us-ssn": make_ssn, "us-itin": make_itin, "us-ein": make_ein,
    "us-routing": make_aba, "us-account": make_us_acct, "us-card": make_card, "us-mbi": make_mbi, "us-npi": make_npi,
    "us-driver-licence": make_us_dl, "us-passport": make_us_passport, "us-phone": make_us_phone,
}


STRONG = ("au-tfn", "au-medicare", "au-abn", "au-acn", "au-ihi", "us-routing", "us-card", "us-npi", "us-mbi", "us-itin")


def looks_like_other_id(typ, s):
    """True if s passes a strong checksum of another ID type, or is a Luhn-valid 13-19 digit run (card-like)."""
    d = "".join(c for c in s if c.isalnum())
    if any(f(d) for k, f in VALIDATORS.items() if k in STRONG and k != typ):
        return True
    return typ != "us-card" and d.isdigit() and 13 <= len(d) <= 19 and luhn_ok(d)


def invalid_ssn(rng):
    while True:
        area = rng.choice(["000", "666", f"{rng.randint(900, 999)}"])
        s = f"{area}-{rng.randint(1, 99):02d}-{rng.randint(1, 9999):04d}"
        if not looks_like_other_id("us-ssn", s):
            return s


def perturb_invalid(typ, canon, rng):
    """Return a same-shape value that fails the type's validator. Types with no checksum cannot be made invalid."""
    ok = VALIDATORS.get(typ)
    if typ == "us-ssn":
        return invalid_ssn(rng)
    if ok is None or typ not in CHECKSUM_TYPES:
        return None
    cands = [canon[:i] + n + canon[i + 1:] for i, c in enumerate(canon) if c.isdigit() for n in DIGITS if n != c]
    rng.shuffle(cands)
    for cand in cands:
        if not ok(cand) and not looks_like_other_id(typ, cand):
            return cand
    return None


def make(typ, rng, valid=True):
    """Canonical value for an ID type, valid or checksum-failing. Returns (text, actually_valid)."""
    if valid:
        return MAKERS[typ](rng), True
    for _ in range(50):
        bad = perturb_invalid(typ, MAKERS[typ](rng), rng)
        if bad is not None:
            return bad, False
    raise ValueError(f"{typ} has no checksum, cannot make an invalid value")
