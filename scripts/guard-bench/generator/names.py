"""Invented people, places and companies. Written for this repo (no third-party list). Combinations are
random, so a generated person is not a real person; suburbs and cities are real public place names."""

GIVEN = (
    "Aiden Amara Ananya Andrew Angela Anthony Aroha Beatrix Benjamin Bianca Brendan Caitlin Callum Carlos Chloe Cian "
    "Daniel Darius Deepak Dimitri Eleni Elijah Emily Esther Fatima Felix Fiona Gabriel Grace Hamish Hannah Harpreet "
    "Hiroshi Imogen Isaac Isla Jacob Jasmine Javier Jessica Jin Joanna Jonathan Kai Kavita Keanu Kenji Layla Liam "
    "Lucia Luke Madeleine Mahmoud Marcus Maria Mateo Mei Mia Michael Mohammed Nadia Natalie Nathan Niamh Noah "
    "Olivia Omar Oscar Pania Patrick Priya Rachel Rafael Rahul Rebecca Riley Ruth Samuel Sana Sarah Sebastian "
    "Shanti Sienna Sofia Stefan Tamsin Thanh Theo Tomasz Tyrone Valentina Victor Wei Willow Xavier Yasmin Zachary Zoe"
).split()

GIVEN_F = (
    "Amara Ananya Angela Aroha Beatrix Bianca Caitlin Chloe Eleni Emily Esther Fatima Fiona Grace Hannah Imogen Isla Jasmine "
    "Jessica Joanna Kavita Layla Lucia Madeleine Maria Mei Mia Nadia Natalie Niamh Olivia Pania Priya Rachel Rebecca Ruth Sana "
    "Sarah Shanti Sienna Sofia Tamsin Valentina Willow Yasmin Zoe"
).split()
GIVEN_M = (
    "Aiden Andrew Anthony Benjamin Brendan Callum Carlos Cian Daniel Darius Deepak Dimitri Elijah Felix Gabriel Hamish Hiroshi "
    "Isaac Jacob Javier Jonathan Keanu Kenji Liam Luke Mahmoud Marcus Mateo Michael Mohammed Nathan Noah Omar Oscar Patrick "
    "Rafael Rahul Samuel Sebastian Stefan Theo Tomasz Tyrone Victor Xavier Zachary"
).split()

SURNAME = (
    "Abbott Adeyemi Alvarez Anderson Bailey Banerjee Barrett Bianchi Brennan Campbell Carvalho Chen Choi Clarke Collins "
    "Costa Dang Delaney Dhillon Dimitriou Donovan Ellis Farouk Ferreira Fitzgerald Fong Foster Garcia Gill Gomez "
    "Gunn Hartley Hassan Hayashi Henderson Hoang Holloway Hughes Ibrahim Jackson Jensen Kapoor Kaur Kelly Khan Kim "
    "Kowalski Lam Larsen Lee Lopez MacDonald Mahoney Malik Marsh Mehta Mitchell Moana Morales Murphy Nakamura "
    "Nguyen Nowak Okafor Olsen O'Connor Papadopoulos Park Patel Pereira Petrov Phillips Quinn Rahman Ramos Reid "
    "Rossi Russo Sandhu Santos Schmidt Sharma Silva Singh Stewart Sullivan Tanaka Thompson Tran Tupou Turner "
    "Vasquez Walker Wang Watts Williams Wong Yamamoto Yilmaz Young Zhang Ziegler"
).split()

AU_SUBURBS = (
    "Parramatta NSW 2150;Newtown NSW 2042;Chatswood NSW 2067;Bondi NSW 2026;Penrith NSW 2750;Wollongong NSW 2500;"
    "Richmond VIC 3121;Brunswick VIC 3056;Footscray VIC 3011;Geelong VIC 3220;Southbank VIC 3006;"
    "Fortitude Valley QLD 4006;Toowong QLD 4066;Southport QLD 4215;Cairns QLD 4870;Subiaco WA 6008;Fremantle WA 6160;"
    "Joondalup WA 6027;Norwood SA 5067;Glenelg SA 5045;Sandy Bay TAS 7005;Launceston TAS 7250;Belconnen ACT 2617;"
    "Braddon ACT 2612;Darwin City NT 0800;Palmerston NT 0830;Newcastle NSW 2300;Ballarat VIC 3350"
).split(";")

US_CITIES = (
    "Springfield IL 62704;Austin TX 78701;Columbus OH 43215;Tampa FL 33602;Phoenix AZ 85004;Portland OR 97204;"
    "Raleigh NC 27601;Denver CO 80202;Albany NY 12207;Sacramento CA 95814;Boise ID 83702;Madison WI 53703;"
    "Nashville TN 37203;Pittsburgh PA 15222;Omaha NE 68102;Richmond VA 23219;Salt Lake City UT 84101;"
    "Tucson AZ 85701;Minneapolis MN 55401;Kansas City MO 64106;Baltimore MD 21202;Atlanta GA 30303;Seattle WA 98101;"
    "Hartford CT 06103;Charlotte NC 28202;Cleveland OH 44113;Louisville KY 40202;Reno NV 89501"
).split(";")

STREETS = (
    "Acacia Ash Banksia Birch Cedar Elm Eucalypt Fern Gum Harbour Hill Jarrah Kauri Lakeview Maple Oak Orchard "
    "Park Pine Queen River Station Sunset Wattle Willow Church Mill King Victoria Albert Railway Cliff Meadow"
).split()
STREET_TYPES_AU = ("Street", "Road", "Avenue", "Drive", "Crescent", "Court", "Lane", "Place", "Parade")
STREET_TYPES_US = ("St", "Ave", "Blvd", "Dr", "Ln", "Rd", "Ct", "Way", "Pkwy")

CO_A = ("Apex Atlas Beacon Bluegum Cardinal Cobalt Crestline Delta Ember Falcon Granite Harbor Ironbark Juniper Keystone "
        "Lumen Meridian Northwind Olympus Pinnacle Quartz Redgum Summit Terrace Union Vertex Westbrook Yarra Zenith").split()
CO_B = ("Partners Group Holdings Solutions Systems Advisory Capital Industries Works Services Associates Enterprises "
        "Consulting Ventures").split()
CO_SUFFIX_AU = ("Pty Ltd", "Pty Limited", "Ltd", "Group Ltd")
CO_SUFFIX_US = ("Inc.", "LLC", "Corp.", "Co.")

EMAIL_DOMAINS_PERSONAL = ("example.com", "example.org", "example.net", "mail.example", "inbox.example")
EMAIL_DOMAIN_FICT_AU = ("example.com.au", "example.net.au")

JOB_TITLES = ("Analyst", "Coordinator", "Manager", "Team Leader", "Officer", "Specialist", "Engineer", "Consultant", "Administrator", "Associate")


def person(rng, sex=None):
    pool = GIVEN_F if sex == "F" else GIVEN_M if sex == "M" else GIVEN
    return rng.choice(pool), rng.choice(SURNAME)


def full_name(rng, who=None):
    g, s = who or person(rng)
    r = rng.random()
    if r < 0.12:
        return f"{s}, {g}"
    if r < 0.2:
        return f"{g} {rng.choice(GIVEN)[0]}. {s}"
    return f"{g} {s}"


def email(rng, jurisdiction="none", name=None):
    g, s = name or person(rng)
    dom = rng.choice(EMAIL_DOMAIN_FICT_AU if jurisdiction == "AU" and rng.random() < 0.5 else EMAIL_DOMAINS_PERSONAL)
    form = rng.choice(("{g}.{s}", "{g}{s}", "{g}_{s}", "{g1}{s}", "{g}.{s}{n}"))
    local = form.format(g=g.lower(), s=s.lower().replace("'", ""), g1=g[0].lower(), n=rng.randint(1, 99))
    return f"{local}@{dom}"


def company(rng, jurisdiction="none"):
    suffix = rng.choice(CO_SUFFIX_US if jurisdiction == "US" else CO_SUFFIX_AU)
    return f"{rng.choice(CO_A)} {rng.choice(CO_B)} {suffix}"


AU_SUBURBS += ["Sydney NSW 2000", "Melbourne VIC 3000", "Brisbane QLD 4000", "Perth WA 6000", "Adelaide SA 5000", "Hobart TAS 7000", "Canberra ACT 2601"]
US_CITIES += ["New York NY 10001", "Los Angeles CA 90012", "Chicago IL 60601", "Houston TX 77002", "Miami FL 33130", "Boston MA 02108"]


AU_HINTS = (("NSW", r"sydney|nsw|new south wales"), ("VIC", r"melbourne|victoria|\bvic\b"), ("QLD", r"brisbane|queensland|\bqld\b|gold coast"), ("WA", r"perth|western australia"), ("SA", r"adelaide|south australia"), ("TAS", r"hobart|tasmania|launceston"), ("ACT", r"canberra"), ("NT", r"darwin|northern territory"))
US_HINTS = (("AZ", "arizona|phoenix|tucson"), ("TX", "texas|austin"), ("FL", "florida|tampa"), ("CA", "california|sacramento"), ("OH", "ohio|columbus|cleveland"), ("IL", "illinois|springfield"), ("NY", "new york|albany"), ("WA", "washington state|seattle"), ("GA", "georgia|atlanta"), ("PA", "pennsylvania|pittsburgh"), ("CO", "colorado|denver"), ("OR", "oregon|portland"), ("NC", "north carolina|raleigh|charlotte"), ("TN", "tennessee|nashville"))


def state_hint(text, hints, table=()):
    import re
    for s in table:
        place = s.rsplit(" ", 2)[0]
        if len(place) > 3 and re.search(r"\b" + re.escape(place) + r"\b", text, re.I):
            return place
    for code, pat in hints:
        if re.search(pat, text, re.I):
            return code
    return None


def pick(rng, table, hint):
    pool = [s for s in table if s.startswith(hint + " ") or s.rsplit(" ", 2)[1] == hint] if hint else []
    return rng.choice(pool or table)


def au_address(rng, hint=None):
    sub = pick(rng, AU_SUBURBS, hint)
    place, state, pc = sub.rsplit(" ", 2)
    unit = f"Unit {rng.randint(1, 40)}/" if rng.random() < 0.25 else ""
    return f"{unit}{rng.randint(1, 240)} {rng.choice(STREETS)} {rng.choice(STREET_TYPES_AU)}, {place} {state} {pc}"


def us_address(rng, hint=None):
    sub = pick(rng, US_CITIES, hint)
    city, state, zp = sub.rsplit(" ", 2)
    apt = f", Apt {rng.randint(1, 30)}{rng.choice('ABCD')}" if rng.random() < 0.2 else ""
    return f"{rng.randint(10, 9899)} {rng.choice(STREETS)} {rng.choice(STREET_TYPES_US)}{apt}, {city}, {state} {zp}"


import datetime
import math

MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")


def dob(rng, jurisdiction="AU", years=None):
    y = rng.randint(*years) if years else rng.randint(1948, 2004)
    m = rng.randint(1, 12)
    d = rng.randint(1, 28)
    if jurisdiction == "US":
        return rng.choice((f"{m:02d}/{d:02d}/{y}", f"{MONTHS[m - 1]} {d}, {y}", f"{y}-{m:02d}-{d:02d}"))
    return rng.choice((f"{d:02d}/{m:02d}/{y}", f"{d} {MONTHS[m - 1]} {y}", f"{d:02d}-{m:02d}-{y}"))


def plain_date(rng, jurisdiction="AU", prev=None):
    """A date later than prev (a datetime.date) so dates read in order. Returns (text, date)."""
    if prev is None:
        day = datetime.date(2024, 1, 1) + datetime.timedelta(days=rng.randint(0, 800))
    else:
        day = prev + datetime.timedelta(days=rng.randint(3, 60))
    text = day.strftime("%m/%d/%Y") if jurisdiction == "US" else day.strftime("%d/%m/%Y")
    return text, day


AMOUNT_RANGE = {"small": (80, 2_500), "mid": (1_500, 30_000), "big": (400_000, 40_000_000), "salary": (55_000, 220_000)}
SALARY_RE = r"salary|wage|remuneration|annual income|earns|package|per annum|base pay|on \$"
BIG_RE = r"acquisition|acquire|takeover|valuation|offering|raise|revenue|turnover|profit|ebitda|\bebit\b|settlement|mortgage|purchase price|budget|contract value|tender|fit-?out|refurb|renovation|asx|nyse|nasdaq|listed"
SMALL_RE = r"fee|fine|per day|per hour|daily|rate|charge|cost|fare|per night|late fee|per pallet|per tonne|per container"


def amount_scale(ctx):
    import re
    for scale, pat in (("salary", SALARY_RE), ("big", BIG_RE), ("small", SMALL_RE)):
        if re.search(pat, ctx, re.I):
            return scale
    return "mid"


def amount(rng, jurisdiction="AU", scale="mid"):
    lo, hi = AMOUNT_RANGE[scale]
    v = int(math.exp(rng.uniform(math.log(lo), math.log(hi))))
    v = round(v, -3) if v >= 50_000 else round(v, -2) if v >= 1000 else round(v, -1)
    return f"${v:,}" if jurisdiction == "US" else f"A${v:,}"


def ref(rng, prefix):
    return f"{prefix}-{rng.randint(100000, 999999)}"
