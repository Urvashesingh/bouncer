/**
 * Hard-negative corpus generator (SPEC §10).
 *
 * These are the messages that LOOK like evasion to a naive detector but are
 * ordinary guest↔host traffic. They define the friction budget: SPEC §10
 * allows ≤0.5% of them to be blocked, so this file is where precision is won
 * or lost.
 *
 * Every category the spec names is represented, each labeled so the benchmark
 * can report which kind of legitimate message causes friction.
 */

import { makeRng } from "./chat-text.js";

export type NegativeKind =
  | "price"
  | "date-time"
  | "pin-code"
  | "booking-ref"
  | "house-number"
  | "flight-number"
  | "guest-count"
  | "distance"
  | "wifi-password"
  | "access-code"
  | "gst-number"
  | "post-booking-address"
  | "intent-word-trap"
  | "phone-model"
  | "review-talk"
  | "ordinary-chat"
  | "borderline";

export interface NegativeEntry {
  id: string;
  text: string;
  kind: NegativeKind;
  label: "negative";
  /** Address sharing is legitimate only post-booking (SPEC §6). */
  stage?: "pre_booking" | "post_booking";
  sender?: "guest" | "host";
}

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)]!;
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const PLACES = ["Goa", "Manali", "Jaipur", "Kochi", "Udaipur", "Shimla", "Pune", "Mysore"];
const NAMES = ["Akshay", "Rahul", "Priya", "Vikram", "Sneha", "Arjun", "Meera", "Karan"];

/** Real IN PIN codes are 6 digits — a classic phone-partial false positive. */
const PIN_CODES = ["403507", "110001", "400001", "560001", "600001", "700001", "302001", "175131"];

const PHONE_MODELS = [
  "iPhone 15 Pro, 256GB", "iPhone 14 128GB", "Samsung Galaxy S24 Ultra 512GB",
  "OnePlus 12 256GB", "Pixel 8 Pro 128GB", "Redmi Note 13 5G 128GB",
  "iPad Air 11 inch 256GB", "MacBook Air M3 16GB 512GB",
];

const INTENT_TRAPS = [
  "lets call it a day, see you tomorrow",
  "it was a close call but we made the train",
  "i will call it quits after this trip",
  "that is a judgement call, your choice",
  "there is a wake up call service at the desk",
  "the doctor is on call all night",
  "we had a courtesy call from the manager",
  "please call ahead if you will be late",
  "i read it in a text book once",
  "the last call for breakfast is at 10",
  "it was a roll call of all the guests",
  "you should book direct flights, they are faster",
];

const REVIEW_TALK = [
  "i left you a 5 star review, loved the place",
  "please read my review when you get a chance",
  "i will write a detailed review about the lovely garden",
  "your reviews were what made us book this place",
  "i gave you a great rating, thanks for everything",
  "the reviews mentioned the view and they were right",
  "could i get a refund for the extra night we did not use?",
  "we had to cancel one night, is a partial refund possible?",
  "i noticed a discount was mentioned in the listing",
  "the review section says checkout is flexible, is that right?",
  "happy to leave a good review, the stay was perfect",
  "i am writing my review now, what is the exact address for reference?",
];

/**
 * Genuinely BORDERLINE legitimate messages — the ones that should land in the
 * escalation band and be resolved as allow.
 *
 * Without these the band contains only positives, and Tier 4 trains on a
 * single class: it learns nothing about where the boundary actually is, scores
 * a perfectly separable set, and reports a meaningless 100% accuracy. These
 * mention channels, numbers and money in innocent ways — exactly the shape of
 * an evasion attempt, minus the intent.
 */
const BORDERLINE = [
  // Coarse register aimed at a THING, not a person. Ordinary guest complaints
  // that a platform must deliver: blocking these mistakes tone for hostility,
  // which is the same error as delivering "fuck off" — just in the opposite
  // direction. Added alongside the profanity positives so the benchmark
  // measures both sides of that line rather than neither.
  "the wifi is a bit crap honestly",
  "we had a shitty flight but arrived fine",
  "damn, that's a great view from the balcony",
  "wtf is the check in time lol",
  "traffic sucks at that hour, we'll be late",
  "the shower pressure sucks a bit but everything else is lovely",
  "the aircon is crap, can it be fixed before we arrive?",
  "what a shitty day of travel we had, sorry for the delay",
  "is there a landline in the room i can use?",
  "my phone has no signal here, is there wifi calling?",
  "do you have a whatsapp business account for the property?",
  "i saw your listing on instagram, is it the same place?",
  "the booking app keeps crashing when i try to message you",
  "can i call the front desk from the room phone?",
  "is there a number for the local taxi service?",
  "my number changed since the booking, should i update it in the app?",
  "the emergency contact number in the house manual is smudged",
  "do you have a direct line for the caretaker in case of emergency?",
  "i tried calling the number listed on the app but no answer",
  "please send the address through the app so i have it saved",
  "the wifi name has a number in it, is it 5g or 2 4g?",
  "we will pay the balance through the platform as agreed",
  "can we settle the extra charges on the app itself?",
  "is the security deposit refundable through the same payment method?",
  "i will book the extra night directly on the app now",
  "my friend wants to book the same villa, should she use the app?",
  "the price on instagram looked different from the app",
  "someone messaged me on whatsapp claiming to be you, is that real?",
  "i got a text asking for payment outside the app, is it legitimate?",
  "please confirm you never ask for payment over whatsapp",
  "the review i left mentions the wifi password issue",
  "i mentioned the gate code in my review by mistake, can it be edited?",
  "can you call me through the app if there is a problem?",
  "does the app support voice calls between guest and host?",
  "i am not comfortable sharing my number, can we keep it in the app?",
  "the listing says contact host, but the button does nothing",
  "how many digits is the gate code, 4 or 6?",
  "the taxi driver asked for the house number and pin code",
];

const ORDINARY = [
  "what time is check in?",
  "is breakfast included in the price?",
  "do you have parking available?",
  "is the wifi good enough for video calls?",
  "we are travelling with a toddler, is that ok?",
  "how far is the nearest beach?",
  "can we get an early check in?",
  "is there a lift in the building?",
  "does the room have air conditioning?",
  "thank you so much for the warm welcome",
  "the place was spotless, we really enjoyed it",
  "kya wahan pe parking milegi?",
  "hum log kal subah pahunch jayenge",
  "bahut acha experience raha, shukriya",
  "koi problem ho to bata dijiyega",
  "please confirm kar dijiye booking",
];

/**
 * Generate the hard-negative corpus.
 * Deterministic given a seed, so friction numbers are reproducible.
 */
export function generateNegatives(target = 1000, seed = 131313): NegativeEntry[] {
  const rng = makeRng(seed);
  const entries: NegativeEntry[] = [];
  let counter = 0;
  const nextId = () => `neg_${String(++counter).padStart(4, "0")}`;

  const push = (text: string, kind: NegativeKind, extra: Partial<NegativeEntry> = {}) => {
    entries.push({ id: nextId(), text, kind, label: "negative", ...extra });
  };

  // --- prices --------------------------------------------------------------
  for (let i = 0; i < 90; i++) {
    const amount = randInt(rng, 1000, 99999);
    const formatted = amount.toLocaleString("en-IN");
    const nights = randInt(rng, 1, 14);
    push(
      pick(
        [
          `the total is ₹${formatted} for ${nights} nights`,
          `it comes to Rs ${formatted} including taxes`,
          `the rate is ₹${randInt(rng, 1500, 9000)} per night`,
          `we can do ₹${formatted} for the whole stay`,
          `INR ${formatted} total, ${nights} nights, breakfast included`,
          `the deposit is ₹${randInt(rng, 2000, 20000)}, refunded at checkout`,
          `price for ${nights} nights is ${formatted} rupees`,
        ],
        rng,
      ),
      "price",
    );
  }

  // --- dates and times -----------------------------------------------------
  for (let i = 0; i < 90; i++) {
    push(
      pick(
        [
          `check in is at ${randInt(rng, 1, 12)} pm on ${randInt(rng, 1, 28)} ${pick(MONTHS, rng)}`,
          `we arrive on ${randInt(rng, 1, 28)}/${randInt(rng, 1, 12)}/202${randInt(rng, 4, 6)}`,
          `checkout is ${randInt(rng, 10, 12)} am sharp`,
          `our train reaches at ${randInt(rng, 1, 12)}:${String(randInt(rng, 0, 59)).padStart(2, "0")} pm`,
          `booking is from ${randInt(rng, 1, 20)} to ${randInt(rng, 21, 28)} ${pick(MONTHS, rng)}`,
          `we will be there around ${randInt(rng, 6, 11)} in the evening`,
          `flight lands ${randInt(rng, 1, 12)}:${String(randInt(rng, 0, 59)).padStart(2, "0")} am`,
        ],
        rng,
      ),
      "date-time",
    );
  }

  // --- PIN codes -----------------------------------------------------------
  for (let i = 0; i < 60; i++) {
    push(
      pick(
        [
          `the pin code here is ${pick(PIN_CODES, rng)}`,
          `our area pincode is ${pick(PIN_CODES, rng)}`,
          `postal code ${pick(PIN_CODES, rng)}, near the main market`,
          `${pick(PLACES, rng)} ${pick(PIN_CODES, rng)}`,
        ],
        rng,
      ),
      "pin-code",
    );
  }

  // --- booking references --------------------------------------------------
  for (let i = 0; i < 60; i++) {
    const ref = `WYZ${randInt(rng, 1000, 9999)}`;
    push(
      pick(
        [
          `booking ref ${ref}`,
          `my reservation id is ${ref}`,
          `confirmation number ${ref}, please check`,
          `order id ${randInt(rng, 100000, 999999)} for the booking`,
          `invoice number INV${randInt(rng, 10000, 99999)}`,
        ],
        rng,
      ),
      "booking-ref",
    );
  }

  // --- house / villa numbers ----------------------------------------------
  for (let i = 0; i < 60; i++) {
    push(
      pick(
        [
          `villa ${randInt(rng, 1, 99)}, second floor`,
          `house no ${randInt(rng, 1, 200)}, near the temple`,
          `flat ${randInt(rng, 101, 999)} in the blue building`,
          `room number ${randInt(rng, 1, 40)} on the ground floor`,
          `apartment ${randInt(rng, 1, 50)}${pick(["A", "B", "C"], rng)}`,
        ],
        rng,
      ),
      "house-number",
    );
  }

  // --- flight numbers ------------------------------------------------------
  for (let i = 0; i < 50; i++) {
    const airline = pick(["6E", "AI", "UK", "SG", "G8", "IX"], rng);
    push(
      pick(
        [
          `flight ${airline} ${randInt(rng, 100, 9999)} lands at ${randInt(rng, 1, 12)} pm`,
          `we are on ${airline}${randInt(rng, 100, 9999)} arriving tomorrow`,
          `our flight ${airline} ${randInt(rng, 100, 9999)} is delayed`,
          `PNR is ${pick(["A", "B", "X"], rng)}${randInt(rng, 10000, 99999)}`,
        ],
        rng,
      ),
      "flight-number",
    );
  }

  // --- guest counts --------------------------------------------------------
  for (let i = 0; i < 50; i++) {
    push(
      pick(
        [
          `we are ${randInt(rng, 2, 8)} adults and ${randInt(rng, 1, 4)} kids`,
          `booking for ${randInt(rng, 1, 10)} people`,
          `${randInt(rng, 2, 6)} guests, ${randInt(rng, 1, 3)} rooms please`,
          `total ${randInt(rng, 2, 12)} of us including children`,
        ],
        rng,
      ),
      "guest-count",
    );
  }

  // --- distances -----------------------------------------------------------
  for (let i = 0; i < 50; i++) {
    push(
      pick(
        [
          `the beach is ${randInt(rng, 100, 900)}m away`,
          `airport is ${randInt(rng, 5, 60)} km from here`,
          `market is ${randInt(rng, 200, 800)} meters down the road`,
          `it takes about ${randInt(rng, 10, 90)} minutes by taxi`,
          `station is ${randInt(rng, 1, 25)} km away, ${randInt(rng, 10, 45)} mins`,
        ],
        rng,
      ),
      "distance",
    );
  }

  // --- wifi passwords ------------------------------------------------------
  for (let i = 0; i < 50; i++) {
    push(
      pick(
        [
          `wifi password is sunshine${randInt(rng, 2020, 2026)}`,
          `the wifi is Guest_${randInt(rng, 100, 999)} and password welcome${randInt(rng, 100, 999)}`,
          `network name is villa${randInt(rng, 1, 20)}, password stay${randInt(rng, 1000, 9999)}`,
          `the internet password is ${pick(["stay", "guest", "villa"], rng)}${randInt(rng, 1000, 9999)}`,
        ],
        rng,
      ),
      "wifi-password",
    );
  }

  // --- access codes: legitimate ONLY once a booking exists ----------------
  // A gate code is physical access to the property. Sending it before a
  // booking is a security problem, not ordinary chat — so these are labelled
  // post_booking, which is when a host genuinely needs to share them.
  for (let i = 0; i < 30; i++) {
    push(
      pick(
        [
          `gate code is ${randInt(rng, 1000, 9999)}`,
          `the door lock pin is ${randInt(rng, 1000, 9999)}`,
          `keypad code ${randInt(rng, 1000, 9999)}, ring if it fails`,
        ],
        rng,
      ),
      "access-code",
      { stage: "post_booking", sender: "host" },
    );
  }

  // --- GST numbers ---------------------------------------------------------
  for (let i = 0; i < 30; i++) {
    push(
      `GST number is ${randInt(rng, 10, 37)}AAPFU${randInt(rng, 1000, 9999)}F1Z${pick(["V", "N", "K"], rng)}`,
      "gst-number",
    );
  }

  // --- post-booking addresses (legitimate at that stage) ------------------
  for (let i = 0; i < 70; i++) {
    push(
      pick(
        [
          `the address is House ${randInt(rng, 1, 99)}, ${pick(PLACES, rng)} ${pick(PIN_CODES, rng)}`,
          `we are at villa ${randInt(rng, 1, 40)}, near the church, ${pick(PLACES, rng)}`,
          `landmark is the blue gate opposite the bakery, flat ${randInt(rng, 101, 505)}`,
          `come to gate ${randInt(rng, 1, 5)}, the caretaker will meet you`,
          `the gate code is ${randInt(rng, 1000, 9999)} and the key is in the box`,
        ],
        rng,
      ),
      "post-booking-address",
      { stage: "post_booking", sender: "host" },
    );
  }

  // --- intent-word traps ---------------------------------------------------
  for (const text of INTENT_TRAPS) push(text, "intent-word-trap");
  for (let i = 0; i < 55; i++) push(pick(INTENT_TRAPS, rng), "intent-word-trap");

  // --- phone models --------------------------------------------------------
  for (let i = 0; i < 45; i++) {
    push(
      pick(
        [
          `i left my ${pick(PHONE_MODELS, rng)} in the room`,
          `is there a charger for ${pick(PHONE_MODELS, rng)}?`,
          `my ${pick(PHONE_MODELS, rng)} does not connect to the wifi`,
          `${pick(PHONE_MODELS, rng)} — did anyone find it?`,
        ],
        rng,
      ),
      "phone-model",
    );
  }

  // --- review talk without threats ----------------------------------------
  for (const text of REVIEW_TALK) push(text, "review-talk");
  for (let i = 0; i < 55; i++) push(pick(REVIEW_TALK, rng), "review-talk");

  // --- borderline: legitimate but evasion-shaped ---------------------------
  for (const text of BORDERLINE) push(text, "borderline");
  for (let i = 0; i < 60; i++) push(pick(BORDERLINE, rng), "borderline");

  // --- ordinary chat, padded to target ------------------------------------
  for (const text of ORDINARY) push(text, "ordinary-chat");
  while (entries.length < target) {
    const style = rng();
    if (style < 0.6) {
      push(pick(ORDINARY, rng), "ordinary-chat");
    } else if (style < 0.8) {
      push(`hi ${pick(NAMES, rng)}, ${pick(ORDINARY, rng)}`, "ordinary-chat");
    } else {
      push(
        `${pick(["thanks", "sure", "ok", "great", "perfect"], rng)}, ${pick(ORDINARY, rng)}`,
        "ordinary-chat",
      );
    }
  }

  return entries;
}
