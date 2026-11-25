/**
 * statBlock.js — sorts a copied-and-pasted monster stat block (WorldAnvil / D&D Beyond
 * style) into labelled pieces, for the DM Site's "Paste Stat Block" tool.
 * Pure text in, plain objects out (no page or database), so it can be tested on its own.
 *
 *   parseStatBlock(text)               -> {name, cr, size, type, alignment, ac, hp, hitDice, speed,
 *                                          abilities, damageImmunities, ..., spellcasting, traits,
 *                                          actions, bonusActions, reactions, legendaryActions,
 *                                          description, environments, unsorted}
 *   statBlockToPreset(parsed, picture) -> a Preset Token, with the stat block stored on it
 *   allyTokenKey(imgs.tokens)          -> the generic ally picture's key
 *   favoritesFromStatBlock(parsed, wholeSpells) -> spells and abilities for the monster's folder
 */

const SIZES = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"];
const ABILITIES = {STR: "Strength", DEX: "Dexterity", CON: "Constitution", INT: "Intelligence", WIS: "Wisdom", CHA: "Charisma"};

//"Label: value" lines in the header, and the field each one fills
const HEADER_LABELS =
{
    "saving throws": "savingThrows",
    "skills": "skills",
    "damage vulnerabilities": "damageVulnerabilities",
    "damage resistances": "damageResistances",
    "damage immunities": "damageImmunities",
    "condition immunities": "conditionImmunities",
    "senses": "senses",
    "languages": "languages"
};

//Section headings that start a new list of abilities
const SECTIONS =
{
    "actions": "actions",
    "bonus actions": "bonusActions",
    "reactions": "reactions",
    "legendary actions": "legendaryActions",
    "lair actions": "lairActions",
    "traits": "traits"
};

//Words before a colon that are part of an attack's text, not a new ability
const NOT_A_NAME = new Set(["hit", "melee weapon attack", "ranged weapon attack", "melee or ranged weapon attack", "melee spell attack", "ranged spell attack", "hit or miss"]);

//Small words allowed inside an ability's name ("Fury of the Tower")
const SMALL = "of|the|and|in|to|a|on|or|for";

//An ability name followed by a colon: Capitalised words, maybe "(Recharges on a long rest)" or "(3/Day)"
const NAME = new RegExp(`([A-Z][A-Za-z'’\\-]*(?: (?:${SMALL}|[A-Z][A-Za-z'’\\-]*)){0,6}(?: \\([^)]*\\))?):\\s`, "g");

/** Tidies one chunk of text: collapses spaces, puts the dropped brackets back round dice averages, ends with a full stop. */
function clean(text)
{
    return text
        .replace(/\s+/g, " ")
        .replace(/\b(\d+) (\d+d\d+(?:\s?[+-]\s?\d+)?)(?![\d(])/g, "$1 ($2)") //"8 1d8+3 slashing" -> "8 (1d8+3) slashing"
        .trim()
        .replace(/([^.!?)"”’])$/, "$1.");
}

/**
 * Splits one run-together paragraph ("Force Powered: ... Immutable Form: ...") into
 * [{name, description}]. Anything before the first name is ignored.
 */
function splitAbilities(paragraph)
{
    let text = paragraph.replace(/\s+/g, " ").trim();
    let found = [];
    NAME.lastIndex = 0;
    let match;

    while((match = NAME.exec(text)) !== null)
    {
        let name = match[1];
        if(NOT_A_NAME.has(name.toLowerCase())){continue;}

        //A real name starts a sentence: the start of the text, after a full stop or bracket,
        //or (when the source lost its full stop) after a lower-case word such as "damage".
        let before = text.slice(0, match.index);
        if(!(before == "" || /[.!?)]\s$/.test(before) || /[a-z0-9]\s$/.test(before))){continue;}

        found.push({name, start: match.index, end: match.index + match[0].length});
    }

    //"Slam. Melee Weapon Attack: ..." inside a Multiattack is an attack of its own
    for(let a of text.matchAll(/\b([A-Z][A-Za-z'’\-]*(?: [A-Z][A-Za-z'’\-]*){0,3})\. (?:Melee|Ranged|Melee or Ranged) (?:Weapon|Spell) Attack:/g))
    {
        found.push({name: a[1], start: a.index, end: a.index + a[1].length + 2});
    }

    found.sort((a, b) => a.start - b.start);
    let abilities = [];

    for(let i = 0; i < found.length; i++)
    {
        let until = i + 1 < found.length ? found[i + 1].start : text.length;
        let body = text.slice(found[i].end, until).trim().replace(/:$/, "").trim();
        abilities.push({name: found[i].name, description: clean(body)});
    }

    return abilities;
}

/** "At will: a, b" / "2/day each: c, d" -> {frequency, spells: []} (null if the line isn't one) */
function parseSpellLine(line)
{
    let match = line.match(/^(at will|cantrips?[^:]*|\d+\/(?:day|long rest|short rest)(?: each)?|\d+(?:st|nd|rd|th)[ -]level[^:]*):\s*(.+)$/i);
    if(!match){return null;}
    let spells = match[2].split(/,\s*(?![^(]*\))/).map(s => s.trim().replace(/\.$/, "")).filter(Boolean);
    return {frequency: match[1].trim(), spells};
}

/**
 * Parses a pasted stat block. Anything it can't place goes in `unsorted` rather than
 * being guessed, so nothing silently disappears.
 */
export function parseStatBlock(raw)
{
    let lines = String(raw ?? "").replace(/\r/g, "").split("\n").map(l => l.trim());
    let out = {abilities: {}, spellcasting: [], traits: [], actions: [], unsorted: []};
    let i = 0;
    let section = "traits";
    let buffers = {};          //section -> its text so far (abilities often arrive as one long line)
    let afterActions = false;  //lore and environments come after the last ability section
    let environments = [];
    let flavour = [];
    let inEnvironments = false;

    while(i < lines.length && lines[i] == ""){i++;}

    //First line: "Arcane GuardianCR: 8" (name and CR run together) or just the name
    if(i < lines.length)
    {
        let first = lines[i++];
        let m = first.match(/^(.*?)\s*CR:?\s*([\d/]+)\s*$/i);
        if(m){out.name = m[1].trim(); out.cr = m[2];}
        else{out.name = first;}
    }

    for(; i < lines.length; i++)
    {
        let line = lines[i];
        if(line == ""){continue;}
        let lower = line.toLowerCase().replace(/:$/, "");

        let crOnly = line.match(/^CR:?\s*([\d/]+)$/i);
        if(crOnly && out.size === undefined){out.cr ??= crOnly[1]; continue;}

        //Ability scores: "STR" then "17 +3" on the next line, or "STR 17 (+3)" on one
        let abil = line.match(/^(STR|DEX|CON|INT|WIS|CHA)\b\s*(\d+)?\s*\(?([+−-]\d+)?\)?$/i);
        if(abil)
        {
            let key = ABILITIES[abil[1].toUpperCase()];
            let score = abil[2], mod = abil[3];

            if(score === undefined)
            {
                let next = (lines[i + 1] ?? "").match(/^(\d+)\s*\(?([+−-]\d+)?\)?$/);
                if(next){score = next[1]; mod = next[2]; i++;}
            }

            if(score !== undefined)
            {
                let n = parseInt(score);
                let calc = Math.floor((n - 10) / 2);
                mod = mod !== undefined ? mod.replace("−", "-") : (calc >= 0 ? "+" : "") + calc;
                out.abilities[key] = {score: n, mod};
                continue;
            }
        }

        //Size, type, alignment: "Medium construct, unaligned"
        let sizeMatch = line.match(new RegExp(`^(${SIZES.join("|")})\\s+([^,]+?)(?:,\\s*(.+))?$`, "i"));
        if(sizeMatch && out.size === undefined && !line.includes(":"))
        {
            out.size = sizeMatch[1];
            out.type = sizeMatch[2].trim();
            out.alignment = (sizeMatch[3] ?? "").trim();
            continue;
        }

        let keyed = line.match(/^([A-Za-z ]+?):\s*(.*)$/);

        if(keyed && !afterActions && out.size !== undefined)
        {
            let label = keyed[1].trim().toLowerCase();
            let value = keyed[2].trim();

            //"Speed:" with its value on the next line (the page puts them in separate boxes)
            let next = (lines[i + 1] ?? "").trim();
            if(value == "" && next != "" && !/^[A-Za-z ]+:/.test(next) && !/^(STR|DEX|CON|INT|WIS|CHA)$/i.test(next)){value = next; i++;}

            if(label == "armor class"){out.ac = (value.match(/\d+/) ?? [""])[0]; out.acNote = value.replace(/^\d+\s*/, "").replace(/^\(|\)$/g, ""); continue;}

            if(label == "hit points")
            {
                out.hp = (value.match(/\d+/) ?? [""])[0];
                let dice = value.match(/\d+d\d+(?:\s?[+-]\s?\d+)?/);
                out.hitDice = dice ? dice[0].replace(/\s/g, "") : "";
                continue;
            }

            if(label == "speed"){out.speed = value; continue;}
            if(label == "challenge rating" || label == "challenge"){out.cr ??= (value.match(/[\d/]+/) ?? [""])[0]; continue;}
            if(label == "proficiency bonus"){out.proficiency = value; continue;}
            if(HEADER_LABELS[label]){out[HEADER_LABELS[label]] = value; continue;}
        }

        //Spellcasting lines ("At will: ...", "1/day: ...")
        let spellLine = parseSpellLine(line);
        if(spellLine && !afterActions){out.spellcasting.push(spellLine); continue;}

        //Section headings ("Actions", "Reactions", ...)
        if(SECTIONS[lower] !== undefined && line.length < 25)
        {
            section = SECTIONS[lower];
            afterActions = section != "traits";
            continue;
        }

        if(/^suggested environments?:?$/i.test(line)){inEnvironments = true; continue;}
        if(inEnvironments){environments.push(line); continue;}

        if(!afterActions && out.size !== undefined)
        {
            buffers.traits = (buffers.traits ? buffers.traits + " " : "") + line; //The traits paragraph
            continue;
        }

        if(afterActions)
        {
            //An ability line starts with "Name:" (or "Name. Melee Weapon Attack:"); anything else is lore
            let looksLikeAbility = /^[A-Z][A-Za-z'’\-]*(?: [A-Za-z'’\-]+){0,6}(?: \([^)]*\))?(?::|\. (?:Melee|Ranged))/.test(line);
            //A line that carries on an unfinished ability ("Hit: 8" then "1d8+3 bludgeoning damage")
            let carriesOn = buffers[section] && flavour.length == 0 && !/[.!?:]$/.test(buffers[section]) && /^[a-z0-9(+-]/.test(line);
            if(looksLikeAbility || carriesOn){buffers[section] = (buffers[section] ? buffers[section] + " " : "") + line;}
            else{flavour.push(line);}
            continue;
        }

        out.unsorted.push(line);
    }

    for(let [key, paragraph] of Object.entries(buffers)){out[key] = splitAbilities(paragraph);}

    out.description = flavour.join("\n");
    out.environments = environments;
    return out;
}

/**
 * The key of the generic ally picture in files/tokens ("genericAlly-", "genericAlly",
 * "generic_ally-"...), or the invisible picture if the site doesn't have one.
 */
export function allyTokenKey(tokens)
{
    let keys = Object.keys(tokens ?? {});
    return keys.find((key) => /^generic[ _-]?ally-?$/i.test(key))
        ?? keys.find((key) => /^genericA-?$/.test(key)) //The generic token {@Summon genericA:...} uses
        ?? "invisible-";
}

/** True for a value worth saving (Firebase drops empty ones and rejects undefined). */
function filled(value)
{
    if(value === undefined || value === null || value === ""){return false;}
    if(Array.isArray(value)){return value.length > 0;}
    if(typeof value == "object"){return Object.keys(value).length > 0;}
    return true;
}

/**
 * The stat block as stored on the token (<token>/statBlock). Fields the pasted text
 * didn't have are left out, so the sheet shows them blank.
 */
export function statBlockRecord(p)
{
    let record = {};
    let keys = ["name", "cr", "size", "type", "alignment", "ac", "acNote", "hp", "hitDice", "speed", "proficiency", "abilities",
        "savingThrows", "skills", "damageVulnerabilities", "damageResistances", "damageImmunities", "conditionImmunities",
        "senses", "languages", "spellcasting", "traits", "actions", "bonusActions", "reactions", "legendaryActions", "lairActions",
        "description", "environments"];

    for(let key of keys){if(filled(p[key])){record[key] = p[key];}}
    return record;
}

/** A Preset Token for the monster: `picture` is the token picture's key, and the stat block rides along. */
export function statBlockToPreset(parsed, picture = "invisible-")
{
    let hp = String(parsed.hp ?? "").trim() || "1";
    let ac = String(parsed.ac ?? "").trim() || "10";
    return {border: "invisible", name: picture, title: parsed.name ?? "", maxHp: hp, currentHp: hp, tempHp: "0", AC: ac,
        isSummon: false, map: "", xPos: "1", yPos: "A", statBlock: statBlockRecord(parsed)};
}

/** Database keys can't hold . # $ [ ] / */
export function safeKey(text)
{
    return String(text).replace(/[.#$\[\]\/]/g, "").replace(/\s+/g, " ").trim();
}

/** "1d8 + 3" -> "1d8+3" (the dashboard's dice reader doesn't allow spaces) */
function tightDice(dice){return dice.replace(/\s+/g, "");}

const DICE = String.raw`\d+d\d+(?:\s*[+-]\s*\d+)?`;

/**
 * Adds the dashboard's roll codes to a monster ability, so using it from the folder rolls:
 *   Attack: "+7 to hit ... Hit: 8 (1d8+3) bludgeoning"  -> "{+7toHit} to hit ... Hit: {@damage 1d8+3} bludgeoning"
 *   Save:   "DC 15 Dexterity saving throw ... 45 (10d8) force damage" -> "{DC15} Dexterity saving throw ... {@save 10d8} force damage"
 * Only the first damage roll gets a code (later dice, like "plus 7 (2d6) fire", stay as text).
 * Abilities with no dice (Multiattack, Magic Resistance...) are left as they are.
 */
export function rollCodes(text)
{
    let out = String(text ?? "");
    let roll = new RegExp(String.raw`\d+\s*\((${DICE})\)`);
    let toHit = out.match(/([+-]\d+)\s+to hit/i);

    if(toHit)
    {
        out = out.replace(toHit[0], `{${toHit[1]}toHit} to hit`);
        out = out.replace(roll, (whole, dice) => `{@damage ${tightDice(dice)}}`);
        return out;
    }

    let dc = out.match(/\bDC\s*(\d+)\b/);
    if(dc && /saving throw/i.test(out))
    {
        out = out.replace(dc[0], `{DC${dc[1]}}`);
        out = out.replace(roll, (whole, dice) => `{@save ${tightDice(dice)}}`);
        if(!out.includes("{@save")){out = out.replace(/saving throw/i, "saving throw {@save}");} //A save with no damage (e.g. a condition)
        return out;
    }

    return out;
}

/**
 * What goes in the monster's favourites folder.
 *   spells    -> [{level, name, spell}] found in the site's spell list (wholeSpells = {level: {name: spell}})
 *   missing   -> spell names that aren't in the list
 *   abilities -> [{tag, name, description}]: every trait and action, filed under the monster's name
 */
export function favoritesFromStatBlock(p, allSpells)
{
    let spells = [];
    let missing = [];
    let seen = new Set();

    for(let line of p.spellcasting ?? [])
    {
        for(let wanted of line.spells ?? [])
        {
            let target = wanted.toLowerCase().replace(/\s*\(.*?\)/g, "").trim();
            if(!target || seen.has(target)){continue;}
            seen.add(target);
            let hit = null;

            for(let [level, list] of Object.entries(allSpells ?? {}))
            {
                for(let [key, spell] of Object.entries(list ?? {}))
                {
                    if(key == "hold"){continue;}
                    if(String(spell?.name ?? key).toLowerCase() == target || key.toLowerCase() == target){hit = {level, name: key, spell}; break;}
                }
                if(hit){break;}
            }

            if(hit){spells.push(hit);}
            else{missing.push(wanted);}
        }
    }

    let abilities = [];
    let tag = safeKey(p.name ?? "Monster") || "Monster";

    for(let group of ["traits", "actions", "bonusActions", "reactions", "legendaryActions", "lairActions"])
    {
        for(let a of p[group] ?? [])
        {
            let name = safeKey(a.name);
            if(name){abilities.push({tag, name, description: rollCodes(a.description ?? "")});}
        }
    }

    return {spells, missing, abilities};
}

/* ------------------------------------------------------------------------------------ *
 *  Open5e (api.open5e.com/v2/creatures): the standard 5e monsters, as the same shape    *
 *  parseStatBlock gives, so the preview, token, folder and sheet all work the same.     *
 * ------------------------------------------------------------------------------------ */

/** 0.25 -> "1/4", 0.5 -> "1/2", 8 -> "8" */
function crText(cr)
{
    if(cr === undefined || cr === null || cr === ""){return "";}
    let n = Number(cr);
    if(n == 0.125){return "1/8";}
    if(n == 0.25){return "1/4";}
    if(n == 0.5){return "1/2";}
    return String(Number.isFinite(n) ? n : cr);
}

function signed(n){return (n >= 0 ? "+" : "") + n;}

/** Open5e text uses markdown (*Melee Weapon Attack:*, _spell_): plain text for the site */
function plain(text)
{
    return String(text ?? "").replace(/[*_]+/g, "").replace(/[ \t]+/g, " ").trim();
}

/** An action's name with how often it can be used: "Gang Up (1/Day)", "Fire Breath (Recharge 5-6)" */
function usageName(action)
{
    let name = plain(action?.name);
    let use = action?.usage_limits;
    if(!use || /\(.*\)\s*$/.test(name)){return name;}
    if(use.type == "PER_DAY"){return `${name} (${use.param}/Day)`;}
    if(use.type == "RECHARGE_ON_ROLL"){return `${name} (Recharge ${use.param == 6 ? "6" : `${use.param}-6`})`;}
    if(use.type == "RECHARGE_AFTER_REST"){return `${name} (Recharges after a Short or Long Rest)`;}
    if(use.type == "RECHARGE"){return `${name} (Recharge)`;}
    return name;
}

/** One Open5e creature -> the same object parseStatBlock returns. */
export function open5eToParsed(c)
{
    let out = {abilities: {}, spellcasting: [], traits: [], actions: [], bonusActions: [], reactions: [], legendaryActions: [], lairActions: [], unsorted: []};
    let names = {strength: "Strength", dexterity: "Dexterity", constitution: "Constitution", intelligence: "Intelligence", wisdom: "Wisdom", charisma: "Charisma"};

    out.name = plain(c?.name);
    out.cr = crText(c?.challenge_rating);
    out.size = c?.size?.name ?? "";
    out.type = String(c?.type?.name ?? "").toLowerCase() + (c?.subcategory ? ` (${c.subcategory})` : "");
    out.alignment = c?.alignment ?? "";
    out.ac = c?.armor_class != null ? String(c.armor_class) : "";
    out.acNote = c?.armor_detail ?? "";
    out.hp = c?.hit_points != null ? String(c.hit_points) : "";
    out.hitDice = c?.hit_dice ?? "";
    out.proficiency = c?.proficiency_bonus != null ? signed(c.proficiency_bonus) : "";

    //Speed: {walk: 30, climb: 15, hover: true} -> "30 ft., climb 15 ft. (hover)"
    let speed = c?.speed ?? {};
    let unit = c?.speed_all?.unit ?? "ft.";
    if(/^(feet|foot|ft)$/i.test(unit)){unit = "ft.";}
    let parts = [];
    if(speed.walk != null){parts.push(`${speed.walk} ${unit}`);}
    for(let kind of ["burrow", "climb", "fly", "swim"]){if(speed[kind] != null){parts.push(`${kind} ${speed[kind]} ${unit}`);}}
    out.speed = parts.join(", ") + (speed.hover ? " (hover)" : "");

    for(let [key, label] of Object.entries(names))
    {
        let score = c?.ability_scores?.[key];
        if(score == null){continue;}
        let mod = c?.modifiers?.[key] ?? Math.floor((score - 10) / 2);
        out.abilities[label] = {score, mod: signed(mod)};
    }

    let saves = Object.entries(c?.saving_throws ?? {}).map(([k, v]) => `${(names[k] ?? k).slice(0, 3)} ${signed(v)}`);
    out.savingThrows = saves.join(", ");
    let skills = Object.entries(c?.skill_bonuses ?? {}).map(([k, v]) => `${k.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())} ${signed(v)}`);
    out.skills = skills.join(", ");

    let r = c?.resistances_and_immunities ?? {};
    out.damageVulnerabilities = r.damage_vulnerabilities_display ?? "";
    out.damageResistances = r.damage_resistances_display ?? "";
    out.damageImmunities = r.damage_immunities_display ?? "";
    out.conditionImmunities = r.condition_immunities_display ?? "";

    let senses = [];
    for(let [key, label] of [["blindsight_range", "Blindsight"], ["darkvision_range", "Darkvision"], ["tremorsense_range", "Tremorsense"], ["truesight_range", "Truesight"]])
    {
        if(c?.[key]){senses.push(`${label} ${c[key]} ${unit}`);}
    }
    if(c?.passive_perception != null){senses.push(`passive Perception ${c.passive_perception}`);}
    out.senses = senses.join(", ");
    out.languages = c?.languages?.as_string ?? "";

    //Traits; a Spellcasting trait's "At will: ..." lines also go in the spell list
    for(let t of c?.traits ?? [])
    {
        let desc = plain(t?.desc);
        out.traits.push({name: plain(t?.name), description: desc});

        if(/spellcasting/i.test(t?.name ?? ""))
        {
            for(let line of String(t?.desc ?? "").split(/\n+/))
            {
                let clean = plain(line).replace(/^[-•]\s*/, "");
                let spells = parseSpellLine(clean);
                if(spells){out.spellcasting.push(spells);}
            }
        }
    }

    let lists = {ACTION: "actions", BONUS_ACTION: "bonusActions", REACTION: "reactions", LEGENDARY_ACTION: "legendaryActions", LAIR_ACTION: "lairActions"};
    let actions = [...(c?.actions ?? [])].sort((a, b) => (a?.order_in_statblock ?? 0) - (b?.order_in_statblock ?? 0));
    for(let a of actions)
    {
        out[lists[a?.action_type] ?? "actions"].push({name: usageName(a), description: plain(a?.desc)});
    }

    out.description = "";
    out.environments = (c?.environments ?? []).map((e) => e?.name).filter(Boolean);
    out.source = c?.document?.display_name ?? c?.document?.name ?? "";
    return out;
}

/** The block number from a WorldAnvil link (…/block/1191121), or null. */
export function blockIdFromLink(link)
{
    let match = String(link ?? "").match(/\/block\/(\d+)/) ?? String(link ?? "").trim().match(/^(\d+)$/);
    return match ? match[1] : null;
}
