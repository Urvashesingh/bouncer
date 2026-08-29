/**
 * Synthetic casual English/Hinglish chat text for trigram training (SPEC §5:
 * "generate synthetic if needed").
 *
 * This is TRAINING text only — it models what legitimate guest↔host chat looks
 * like at the character level. The labeled benchmark corpus is a separate
 * artifact and arrives at build-order step 6.
 *
 * The point is character-level coverage, not semantic realism: the trigram
 * model only ever sees [a-z0-9 ]. Templates are combined combinatorially to
 * reach the "few MB" SPEC §5 asks for.
 */

const GREETINGS = [
  "hi", "hello", "hey", "namaste", "good morning", "good evening", "gm", "hii",
  "hey there", "hello ji", "namaskar", "good afternoon", "hi there",
];

const HOST_LINES = [
  "welcome to our home we hope you enjoy your stay",
  "check in is from 2 pm and check out is at 11 am",
  "the wifi password is written on the fridge",
  "there is a supermarket just around the corner",
  "please let me know your approximate arrival time",
  "the caretaker will meet you at the gate",
  "hot water is available in all bathrooms",
  "we provide fresh towels every second day",
  "parking is available inside the compound",
  "the terrace has a lovely view of the hills",
  "breakfast can be arranged for an extra charge",
  "please do not smoke inside the rooms",
  "the ac remote is on the bedside table",
  "kindly switch off the lights when you go out",
  "our housekeeping comes in the morning",
  "let me know if you need extra blankets",
  "the nearest beach is a short walk away",
  "we have a backup generator during power cuts",
  "please carry a valid id proof for check in",
  "the kitchen is fully stocked with utensils",
  "aap ka room ready hai aap aa sakte hain",
  "koi bhi problem ho to bataiye",
  "hum aapko address bhej denge",
  "ghar ke bahar hi parking mil jayegi",
  "sab kuch saaf suthra hai aap enjoy kijiye",
  "agar late ho to please inform kar dena",
  "yahan pe bahut acha khana milta hai",
  "main subah tak available rahunga",
];

const GUEST_LINES = [
  "thanks for the quick response",
  "we will be arriving late in the evening",
  "is early check in possible on that day",
  "do you allow pets in the property",
  "how far is the railway station from there",
  "we are a family of four with two kids",
  "is the place suitable for elderly people",
  "can we get an extra mattress in the room",
  "the pictures look really lovely",
  "what is the cancellation policy",
  "does the room have a balcony",
  "is drinking water provided in the room",
  "we had a wonderful stay thank you so much",
  "the host was very helpful and responsive",
  "the location was perfect for our trip",
  "everything was clean and well maintained",
  "we would definitely book this place again",
  "could you please confirm the booking",
  "is there a lift in the building",
  "we need the place for three nights",
  "kya wahan pe parking available hai",
  "hum log kal subah pahunch jayenge",
  "bahut acha experience raha thank you",
  "kitne log ruk sakte hain ek room me",
  "please confirm kar dijiye booking",
  "hume thoda late ho jayega aane me",
  "khana ka kya arrangement hai wahan",
  "sab kuch bahut acha tha shukriya",
];

const FILLERS = [
  "ok", "okay", "sure", "thanks", "thank you", "great", "perfect", "no problem",
  "sounds good", "alright", "got it", "understood", "yes", "no", "maybe",
  "please", "welcome", "cheers", "haan", "nahi", "theek hai", "acha", "bilkul",
  "ji haan", "koi baat nahi", "shukriya", "dhanyavaad", "zaroor", "bohot acha",
];

const NOUNS = [
  "room", "house", "villa", "apartment", "flat", "kitchen", "bathroom", "bed",
  "towel", "key", "gate", "door", "window", "balcony", "terrace", "garden",
  "pool", "beach", "market", "station", "airport", "taxi", "driver", "host",
  "guest", "booking", "payment", "receipt", "invoice", "checkout", "luggage",
  "breakfast", "dinner", "lunch", "water", "power", "wifi", "internet", "ac",
  "fan", "heater", "geyser", "sofa", "chair", "table", "cupboard", "mirror",
];

const ADJECTIVES = [
  "clean", "nice", "lovely", "comfortable", "spacious", "cozy", "beautiful",
  "quiet", "peaceful", "convenient", "affordable", "friendly", "helpful",
  "quick", "easy", "safe", "warm", "cool", "fresh", "bright", "modern",
];

const VERBS = [
  "book", "stay", "arrive", "leave", "check", "confirm", "cancel", "call",
  "message", "send", "share", "provide", "arrange", "clean", "wash", "cook",
  "park", "walk", "reach", "visit", "enjoy", "relax", "rest", "sleep",
];

/** Legitimate numeric content — the model must not find digits weird per se. */
const NUMERIC_LINES = [
  "the total is 4500 for two nights",
  "check in at 2 pm and check out at 11 am",
  "the pin code here is 403507",
  "we are 4 adults and 2 children",
  "the beach is 700 m away",
  "room number 12 on the second floor",
  "the rate is 3200 per night plus taxes",
  "booking reference is wyz8842",
  "it takes about 45 minutes from the airport",
  "there are 3 bedrooms and 2 bathrooms",
  "the gate code is 4455",
  "we stayed for 5 nights in march 2024",
  "the property is 15 km from the city centre",
  "gst is 12 percent on the total amount",
  "please arrive before 10 pm",
];

/**
 * Personal names and place names.
 *
 * These matter more than they look. Without broad name coverage the model
 * treats every unseen name as improbable, and "akshay" scores as weird as
 * "a121ksh35ay" — which would destroy the detector's precision. Names are a
 * large, high-entropy part of real chat, so the model must know their shape.
 */
const NAMES = [
  "akshay", "rahul", "priya", "amit", "sneha", "vikram", "anjali", "rohit",
  "kavita", "arjun", "meera", "sanjay", "pooja", "karan", "divya", "manish",
  "neha", "suresh", "ritu", "ajay", "swati", "deepak", "nisha", "gaurav",
  "shreya", "vishal", "aarti", "nikhil", "isha", "raj", "simran", "varun",
  "tanya", "abhishek", "payal", "siddharth", "komal", "ashish", "preeti",
  "harsh", "sakshi", "mohit", "jyoti", "rakesh", "anita", "vivek", "sunita",
  "naveen", "geeta", "prakash", "lakshmi", "ganesh", "radha", "krishna",
  "shiva", "aditya", "ananya", "ishaan", "aryan", "diya", "kabir", "myra",
  "vihaan", "saanvi", "reyansh", "anaya", "arnav", "navya", "shaurya", "riya",
  "john", "mary", "david", "sarah", "michael", "emma", "james", "olivia",
  "robert", "sophia", "william", "isabella", "thomas", "mia", "daniel", "ava",
  "joseph", "chloe", "peter", "grace", "andrew", "lucy", "richard", "hannah",
  "fernandes", "dsouza", "pereira", "gomes", "rodrigues", "almeida", "pinto",
  "sharma", "verma", "gupta", "singh", "kumar", "patel", "shah", "mehta",
  "joshi", "desai", "iyer", "nair", "menon", "reddy", "rao", "naidu", "pillai",
  "chatterjee", "banerjee", "mukherjee", "bose", "ghosh", "dutta", "sen",
];

const PLACES = [
  "goa", "mumbai", "delhi", "bangalore", "pune", "chennai", "kolkata",
  "hyderabad", "jaipur", "udaipur", "manali", "shimla", "rishikesh", "varanasi",
  "kochi", "munnar", "alleppey", "ooty", "coorg", "mysore", "pondicherry",
  "darjeeling", "gangtok", "srinagar", "leh", "ladakh", "dharamshala",
  "kasol", "mcleodganj", "anjuna", "baga", "calangute", "candolim", "vagator",
  "arambol", "palolem", "colva", "panjim", "mapusa", "margao", "vasco",
  "andheri", "bandra", "juhu", "colaba", "powai", "thane", "navi", "worli",
  "koramangala", "indiranagar", "whitefield", "jayanagar", "malleswaram",
  "airport", "junction", "terminal", "highway", "circle", "chowk", "nagar",
  "colony", "layout", "enclave", "vihar", "puram", "pally", "halli", "wadi",
];

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
];

const DAYS = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "yesterday", "weekend", "weekday", "morning", "evening",
  "afternoon", "night", "midnight", "noon",
];

/**
 * Broad everyday vocabulary. Trigram coverage is what keeps the model from
 * calling ordinary words weird, so breadth here matters more than any single
 * sentence template.
 */
const COMMON_WORDS = [
  "about", "above", "across", "after", "again", "against", "already", "also",
  "although", "always", "another", "answer", "anyone", "anything", "around",
  "arrive", "available", "because", "before", "behind", "believe", "below",
  "besides", "better", "between", "beyond", "brought", "building", "business",
  "cannot", "certainly", "change", "charge", "children", "choose", "close",
  "coming", "comfortable", "complete", "condition", "consider", "contact",
  "continue", "correct", "could", "country", "couple", "course", "create",
  "current", "customer", "decide", "definitely", "delay", "deliver", "depend",
  "describe", "detail", "different", "difficult", "direction", "discuss",
  "distance", "during", "early", "either", "enough", "entire", "especially",
  "evening", "event", "every", "exactly", "example", "except", "expect",
  "experience", "explain", "family", "feel", "figure", "final", "follow",
  "friend", "further", "future", "general", "getting", "given", "government",
  "group", "happen", "happy", "having", "health", "hear", "help", "himself",
  "history", "holiday", "hope", "however", "hundred", "important", "include",
  "increase", "indeed", "inside", "instead", "interest", "issue", "itself",
  "journey", "keep", "kind", "know", "language", "large", "last", "late",
  "learn", "least", "leave", "letter", "level", "life", "light", "likely",
  "listen", "little", "living", "local", "long", "look", "lovely", "machine",
  "manage", "many", "market", "matter", "mean", "measure", "meet", "member",
  "mention", "middle", "might", "minute", "moment", "money", "month", "morning",
  "most", "mother", "move", "much", "music", "must", "name", "national",
  "natural", "near", "necessary", "need", "never", "next", "night", "north",
  "nothing", "notice", "number", "obviously", "occasion", "offer", "office",
  "often", "once", "only", "open", "opportunity", "order", "other", "outside",
  "over", "particular", "party", "people", "perhaps", "period", "person",
  "picture", "place", "plan", "play", "please", "point", "policy", "poor",
  "position", "possible", "power", "practice", "prefer", "prepare", "present",
  "pretty", "prevent", "price", "probably", "problem", "process", "produce",
  "program", "project", "proper", "provide", "public", "purpose", "quality",
  "question", "quickly", "quite", "rather", "reach", "read", "ready", "real",
  "reason", "receive", "recent", "recommend", "record", "reduce", "refer",
  "regard", "region", "regular", "relate", "remain", "remember", "remove",
  "repeat", "reply", "report", "request", "require", "research", "reserve",
  "respect", "respond", "result", "return", "right", "river", "road", "room",
  "round", "rule", "safe", "same", "school", "season", "second", "section",
  "seem", "sell", "send", "sense", "separate", "series", "serious", "serve",
  "service", "several", "shall", "share", "short", "should", "show", "side",
  "sign", "similar", "simple", "since", "single", "sister", "site", "situation",
  "small", "social", "society", "someone", "something", "sometimes", "soon",
  "sorry", "sound", "source", "south", "space", "speak", "special", "specific",
  "spend", "stand", "standard", "start", "state", "station", "still", "stop",
  "story", "street", "strong", "student", "study", "subject", "success",
  "suggest", "summer", "supply", "support", "suppose", "sure", "surface",
  "system", "table", "take", "talk", "teach", "team", "tell", "temperature",
  "term", "test", "than", "thank", "their", "them", "then", "there", "these",
  "they", "thing", "think", "third", "this", "those", "though", "thought",
  "three", "through", "throughout", "time", "today", "together", "tomorrow",
  "tonight", "total", "toward", "town", "trade", "traffic", "train", "travel",
  "treat", "trip", "trouble", "true", "trust", "turn", "type", "under",
  "understand", "unit", "until", "usually", "value", "various", "very",
  "village", "visit", "voice", "wait", "walk", "want", "warm", "watch",
  "water", "weather", "week", "weight", "welcome", "well", "west", "what",
  "when", "where", "whether", "which", "while", "white", "whole", "whose",
  "will", "wind", "window", "wish", "with", "within", "without", "woman",
  "wonder", "word", "work", "world", "worry", "worth", "would", "write",
  "wrong", "year", "young", "your", "yourself",
];

/**
 * Brands, products and tech words. Real chat is full of these ("iPhone 15 Pro,
 * 256GB" is an explicit hard negative in SPEC §10), and the weirdness meter
 * flags UNFAMILIAR text, not just mangled text — so anything genuinely common
 * must be in training or it becomes a false positive.
 */
const PRODUCT_WORDS = [
  "iphone", "android", "samsung", "xiaomi", "redmi", "oneplus", "realme",
  "oppo", "vivo", "nokia", "motorola", "google", "pixel", "apple", "macbook",
  "laptop", "tablet", "charger", "adapter", "cable", "bluetooth", "wifi",
  "router", "modem", "hotspot", "netflix", "youtube", "prime", "spotify",
  "uber", "ola", "rapido", "zomato", "swiggy", "amazon", "flipkart",
  "makemytrip", "goibibo", "airbnb", "booking", "agoda", "trivago",
  "camera", "battery", "screen", "display", "storage", "memory", "processor",
  "wireless", "headphones", "earbuds", "speaker", "printer", "scanner",
  "geyser", "inverter", "microwave", "fridge", "freezer", "washing", "dryer",
  "induction", "chimney", "purifier", "humidifier", "kettle", "toaster",
];

/** Hinglish vocabulary — the model must not treat romanised Hindi as weird. */
const HINGLISH_WORDS = [
  "aap", "aapka", "aapke", "aapki", "hum", "hume", "hamara", "hamare", "mera",
  "mere", "meri", "tera", "tere", "uska", "unka", "yahan", "wahan", "kahan",
  "kaise", "kaisa", "kyun", "kyunki", "kitna", "kitne", "kitni", "jyada",
  "thoda", "bahut", "bohot", "acha", "accha", "achha", "bura", "sahi", "galat",
  "theek", "thik", "haan", "nahi", "nahin", "kuch", "sab", "sabhi", "koi",
  "kisi", "phir", "abhi", "kabhi", "jaldi", "der", "subah", "shaam", "raat",
  "din", "kal", "aaj", "parso", "hafta", "mahina", "saal", "samay", "waqt",
  "ghar", "kamra", "makan", "chabi", "darwaza", "khidki", "chhat", "bahar",
  "andar", "upar", "niche", "aage", "peeche", "paas", "door", "seedha",
  "khana", "pani", "chai", "nashta", "dopahar", "raat", "bistar", "chadar",
  "saaf", "ganda", "naya", "purana", "bada", "chota", "sasta", "mehnga",
  "paisa", "paise", "rupaye", "kirdaya", "booking", "karna", "karo", "kijiye",
  "dena", "dijiye", "lena", "lijiye", "aana", "aaiye", "jana", "jaiye",
  "bataiye", "batao", "suniye", "suno", "dekhiye", "dekho", "milna", "milega",
  "hoga", "hogi", "honge", "raha", "rahi", "rahe", "gaya", "gayi", "gaye",
  "chahiye", "sakta", "sakte", "sakti", "padega", "padegi", "wapas", "shukriya",
  "dhanyavaad", "namaste", "namaskar", "swagat", "maaf", "kripya", "zaroor",
  "bilkul", "shayad", "matlab", "yaani", "lekin", "magar", "agar", "warna",
  "taki", "jab", "tab", "jaisa", "waisa", "itna", "utna", "aisa", "waisa",
];

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)]!;
}

/** Deterministic PRNG so training output is reproducible. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * All single-word vocabulary, for free-form line generation.
 *
 * Fixed sentence templates alone produce a narrow trigram distribution: the
 * model overfits to those exact phrasings and calls every unseen ordinary word
 * improbable. Sampling words independently is what gives the broad coverage
 * the weirdness meter needs to separate "akshay" from "a121ksh35ay".
 */
const ALL_WORDS = [
  ...COMMON_WORDS, ...HINGLISH_WORDS, ...NAMES, ...PLACES, ...MONTHS, ...DAYS,
  ...NOUNS, ...ADJECTIVES, ...VERBS, ...FILLERS, ...GREETINGS, ...PRODUCT_WORDS,
];

/** Units that legitimately attach to digits: "256gb", "700m", "12mp". */
const UNIT_SUFFIXES = ["gb", "mb", "tb", "kg", "km", "cm", "mm", "ml", "mp", "mah", "hz", "pm", "am"];

/** Generate one synthetic chat line. */
export function generateLine(rng: () => number): string {
  const roll = rng();

  // ~55% free-form word sequences: the bulk of trigram coverage.
  if (roll < 0.55) {
    const length = 3 + Math.floor(rng() * 10);
    const words: string[] = [];
    for (let i = 0; i < length; i++) words.push(pick(ALL_WORDS, rng));
    return words.join(" ");
  }

  // ~45% realistic phrasing, so common sequences stay common.
  if (roll < 0.63) return pick(HOST_LINES, rng);
  if (roll < 0.71) return pick(GUEST_LINES, rng);
  if (roll < 0.77) return pick(NUMERIC_LINES, rng);
  if (roll < 0.82) return `${pick(GREETINGS, rng)} ${pick(NAMES, rng)} ${pick(FILLERS, rng)}`;
  if (roll < 0.87) return `${pick(GREETINGS, rng)} ${pick(rng() < 0.5 ? HOST_LINES : GUEST_LINES, rng)}`;
  if (roll < 0.91) return `the ${pick(ADJECTIVES, rng)} ${pick(NOUNS, rng)} is ${pick(ADJECTIVES, rng)}`;
  if (roll < 0.95) return `we will ${pick(VERBS, rng)} the ${pick(NOUNS, rng)} ${pick(FILLERS, rng)}`;
  if (roll < 0.97) return `${pick(NAMES, rng)} is staying in ${pick(PLACES, rng)} till ${pick(MONTHS, rng)}`;
  // Digit+unit compounds, so "256gb" and "700m" are familiar shapes.
  if (roll < 0.99) {
    const value = 1 + Math.floor(rng() * 999);
    return `${pick(PRODUCT_WORDS, rng)} ${value}${pick(UNIT_SUFFIXES, rng)} ${pick(FILLERS, rng)}`;
  }
  return `${pick(FILLERS, rng)} ${pick(VERBS, rng)} the ${pick(NOUNS, rng)} on ${pick(DAYS, rng)}`;
}

/** Generate `count` lines of synthetic chat text. */
export function generateChatCorpus(count: number, seed = 20260802): string[] {
  const rng = makeRng(seed);
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(generateLine(rng));
  return lines;
}
