/**
 * stats.js — the character sheet (stats.html, shown inside the dashboard's Sheet tab).
 *
 * The sheet has no database connection of its own: it reads and writes the player's
 * character through the dashboard (`parent` = window.top.parent, filled by parent.js).
 *
 * How the sheet is wired:
 *   • Every field that is saved has class="stat" and an id matching its database key,
 *     stored at playerChar/<Player>/stats/<id>.
 *   • Checkboxes ending in "-btn" are proficiencies: "stealth-btn" ticks Stealth, and
 *     "dexteritySave-btn" a saving throw. The bonus shown next to it is calculated.
 *   • Ability scores have class "base6"; changing one recalculates its modifier.
 *   • Spell boxes (can-1, lvl1-1, ...) have an eye icon (id + "-See") that opens the
 *     spell's details, and spell slots draw clickable slot icons.
 *   • Right-clicking a skill or Initiative rolls a d20 with that bonus and posts it to Discord.
 */

"use strict";
import { toTitleCase, setDoc, statFormat, skillDecrypt, reload, deleteDoc, sendDiscordMessage, showPopup } from './viMethods.js';

let stats;
let firstRun = true;
let characterSheetStarted = false; //The character sheet is only set up once (the monster sheet can switch to it)
// The dashboard page (index.html). All character data comes from parent.wholeChar.
let parent = window.top.parent;

startSheet();

/**
 * Picks which sheet to show. While you control a token that carries a stat block (made by the
 * DM Site's Paste Stat Block), the sheet shows that monster instead of your character, with a
 * button to switch back. Otherwise it's the normal character sheet.
 * The map's tokens can arrive a moment after the characters, so it waits briefly for them.
 */
function startSheet(tries = 0)
{
    let me = parent.wholeChar?.[parent.player];
    let tokenId = me?.["currentToken"];
    let mapReady = Object.keys(parent.wholeDB ?? {}).length > 0;

    if(me && tokenId && tokenId != parent.player && !mapReady && tries < 10)
    {
        setTimeout(() => startSheet(tries + 1), 300);
        return;
    }

    let token = tokenId && tokenId != parent.player ? parent.wholeDB?.[tokenId] : null;

    if(token?.["statBlock"])
    {
        showMonsterSheet(token);
        return;
    }

    characterSheetStarted = true;
    init();
}

/**
 * Fills #monsterSheet from the token's stat block and hides the character sheet. Read-only:
 * nothing here is saved, so your own character's sheet is never touched. Every heading is
 * shown; a field the stat block didn't have is left blank. Spell names open their card.
 */
function showMonsterSheet(token)
{
    let m = token["statBlock"];
    let sheet = document.getElementById("monsterSheet");
    document.getElementById("story").style.display = "none";
    sheet.innerHTML = "";
    sheet.style.display = "block";

    let el = (tag, cls, text) => {let e = document.createElement(tag); if(cls){e.className = cls;} if(text !== undefined && text !== null){e.textContent = text;} return e;};
    let value = (v) => (v === undefined || v === null) ? "" : String(v);

    //A labelled box: <p>Label:</p><h6>value</h6>
    let field = (label, v) =>
    {
        let cell = el("td");
        cell.appendChild(el("p", "", `${label}:`));
        cell.appendChild(el("h6", "monsterValue", value(v)));
        return cell;
    };

    let paper = () => {let t = el("table", "paper statSheet monsterPaper"); t.style.width = "100%"; sheet.appendChild(t); return t;};
    let row = (table, cells) => {let r = el("tr"); cells.forEach((c) => r.appendChild(c)); table.appendChild(r); return r;};

    //Top bar: whose sheet this is, and the way back to your own
    let bar = el("div", "monsterBar");
    bar.appendChild(el("span", "", `Controlling ${value(token["title"]).split(":")[0] || value(m["name"])}`));
    let back = el("button", "gridButton", "Show my sheet");
    back.onclick = () => {sheet.style.display = "none"; document.getElementById("story").style.display = ""; if(!characterSheetStarted){characterSheetStarted = true; init();}};
    bar.appendChild(back);
    sheet.appendChild(bar);

    // --- Who it is ---
    let head = paper();
    row(head, [
        field("Name", m["name"]),
        field("Size, Type & Alignment", [m["size"], m["type"]].filter(Boolean).join(" ") + (m["alignment"] ? `, ${m["alignment"]}` : "")),
        field("Challenge Rating", m["cr"])
    ]);

    // --- Fighting numbers (HP is the token's live HP) ---
    let hp = `${value(token["currentHp"])} / ${value(token["maxHp"] ?? m["hp"])}`;
    if(token["tempHp"] && token["tempHp"] != "0"){hp += ` (+${token["tempHp"]} temp)`;}
    let combat = paper();
    row(combat, [
        field("Armor Class", value(token["AC"] ?? m["ac"]) + (m["acNote"] ? ` (${m["acNote"]})` : "")),
        field("Hit Points", hp),
        field("Hit Dice", m["hitDice"]),
        field("Speed", m["speed"]),
        field("Proficiency", m["proficiency"])
    ]);

    // --- Ability scores ---
    let scores = paper();
    let names = ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"];
    row(scores, names.map((name) =>
    {
        let a = m["abilities"]?.[name];
        let cell = el("td");
        cell.appendChild(el("p", "", `${name.slice(0, 3)}:`));
        cell.appendChild(el("h6", "monsterValue", a ? String(a["score"]) : ""));
        let mod = el("h6", "monsterMod", a ? a["mod"] : "");
        mod.style.border = "2px solid";
        cell.appendChild(mod);
        return cell;
    }));

    // --- Defences and senses ---
    let details = paper();
    let pairs = [["Saving Throws", "savingThrows"], ["Skills", "skills"], ["Damage Vulnerabilities", "damageVulnerabilities"],
        ["Damage Resistances", "damageResistances"], ["Damage Immunities", "damageImmunities"], ["Condition Immunities", "conditionImmunities"],
        ["Senses", "senses"], ["Languages", "languages"]];
    for(let k = 0; k < pairs.length; k += 2)
    {
        row(details, pairs.slice(k, k + 2).map(([label, key]) => field(label, m[key])));
    }

    // --- Lists: spellcasting, traits, actions... ---
    let list = (title, fill) =>
    {
        let t = paper();
        let cell = el("td", "monsterList");
        cell.appendChild(el("h6", "", title));
        let before = cell.childNodes.length;
        fill(cell);
        if(cell.childNodes.length == before){cell.appendChild(el("p", "monsterEmpty", ""));}
        row(t, [cell]);
    };

    let entry = (cell, name, text) =>
    {
        let p = el("p", "monsterEntry");
        p.appendChild(el("b", "", `${name}. `));
        p.appendChild(document.createTextNode(value(text)));
        cell.appendChild(p);
    };

    list("Spellcasting", (cell) =>
    {
        for(let line of m["spellcasting"] ?? [])
        {
            let p = el("p", "monsterEntry");
            p.appendChild(el("b", "", `${line["frequency"]}: `));
            (line["spells"] ?? []).forEach((name, k) =>
            {
                if(k > 0){p.appendChild(document.createTextNode(", "));}
                let link = el("span", "monsterSpell", name);
                link.title = "Show this spell";
                link.onclick = () => showSpellByName(name);
                p.appendChild(link);
            });
            cell.appendChild(p);
        }
    });

    list("Traits", (cell) => {for(let t of m["traits"] ?? []){entry(cell, t["name"], t["description"]);}});
    list("Actions", (cell) => {for(let a of m["actions"] ?? []){entry(cell, a["name"], a["description"]);}});
    list("Bonus Actions", (cell) => {for(let a of m["bonusActions"] ?? []){entry(cell, a["name"], a["description"]);}});
    list("Reactions", (cell) => {for(let a of m["reactions"] ?? []){entry(cell, a["name"], a["description"]);}});
    list("Legendary Actions", (cell) => {for(let a of m["legendaryActions"] ?? []){entry(cell, a["name"], a["description"]);}});
    if(m["lairActions"]){list("Lair Actions", (cell) => {for(let a of m["lairActions"]){entry(cell, a["name"], a["description"]);}});}

    list("Lore", (cell) => {for(let para of value(m["description"]).split("\n").filter(Boolean)){cell.appendChild(el("p", "monsterEntry", para));}});
    list("Environments", (cell) => {if(m["environments"]){cell.appendChild(el("p", "monsterEntry", m["environments"].join(", ")));}});
}

/**
 * Opens a spell's card by name (any level), the same way the eye icons do.
 */
function showSpellByName(name)
{
    let target = String(name).toLowerCase().replace(/\s*\(.*?\)/g, "").trim();
    let spell = null;

    for(let level of Object.values(parent.wholeSpells ?? {}))
    {
        for(let [key, s] of Object.entries(level ?? {}))
        {
            if(key != "hold" && (key.toLowerCase() == target || String(s?.["name"] ?? "").toLowerCase() == target)){spell = s; break;}
        }
        if(spell){break;}
    }

    if(!spell)
    {
        let link = `https://roll20.net/compendium/dnd5e/${encodeURIComponent(toTitleCase(target))}`;
        showPopup({boxClass: "popupTall", title: toTitleCase(target), html: `<iframe class="popupFrame" src="${link}" title="spell"></iframe>`});
        return;
    }

    let line = (label, v) => `<p class="card-text">${label}: ${v ?? ""}</p>`;
    showPopup({boxClass: "popupSpell", html:
        `<div class="card-body notes">
            <h5 class="card-title">${spell["name"]}</h5>
            ${line("Cast Time", spell["castTime"])}
            ${line("Range", spell["range"])}
            ${line("Components", spell["components"])}
            ${line("Duration", spell["duration"])}
            ${spell["concentration"] == "true" ? `<p class="card-text">Concentration</p>` : ""}
            <p class="card-text">${spell["description"]}</p>
        </div>`});
}

/**
 * Fills every class="stat" field from the saved character. Calculated fields (spell attack
 * bonus, spell save DC, proficiency bonus, hit dice) are worked out here and saved back.
 * Also hooks up the eye icons, expertise clicks, right-click rolls and the hit-dice buttons.
 * If the dashboard's data isn't there yet, the sheet reloads itself to try again.
 */
function init()
{
    let display = document.getElementById("story");
    let stats = document.getElementsByClassName("stat");
    let viewButtons = document.getElementsByClassName("viewSpell");
    let exitBtn = document.getElementById("exitIframe");
    exitBtn.onclick = handleExit;
    document.getElementById("spellBackdrop").onclick = handleExit; //Click outside the popup to close it
    document.addEventListener("keydown", (e) => {if(e.key == "Escape"){handleExit();}});

    for(let stat of stats)
    {
        if(parent.wholeChar[parent.player] == undefined)
        {
            setTimeout(() => location.reload(), 1000); //Try again in a second
            return;
        }

        else if(parent.wholeChar[parent.player]["stats"][stat.id] || parent.wholeChar[parent.player]["stats"][stat.id] == "")
        {
            if(!parent.wholeChar[parent.player]["stats"][stat.id]){setDoc(`playerChar/${parent.player}/stats/${stat.id}`, "");}
            if(typeof parent.wholeChar[parent.player]["stats"][stat.id] == "string")
            {
                if(stat.id == "spellBonus"){let bonus = statFormat(parseInt(parent.wholeChar[parent.player]["stats"][parent.wholeChar[parent.player]["stats"]["spellAbility"]]) + parseInt(parent.wholeChar[parent.player]["stats"]["proficiency"])); stat.innerHTML = bonus; setDoc(`playerChar/${parent.player}/stats/spellBonus`, bonus);}
                else if(stat.id == "spellDC"){let dc = statFormat(parseInt(parent.wholeChar[parent.player]["stats"][parent.wholeChar[parent.player]["stats"]["spellAbility"]]) + parseInt(parent.wholeChar[parent.player]["stats"]["proficiency"]) + 8); stat.innerHTML = dc; setDoc(`playerChar/${parent.player}/stats/spellDC`, dc);}
                else if(stat.id == "proficiency"){let prof = statFormat(Math.ceil(parseInt(parent.wholeChar[parent.player]["stats"]["lv"])/4)+1); setDoc(`playerChar/${parent.player}/stats/proficiency`, prof); stat.innerHTML = prof;}
                else if(stat.id == "name"){stat.innerHTML = parent.player;}
                else if(stat.id == "totalHitDice"){for(let i = 0; i < stat.length; i++){stat[i].innerHTML = `${parent.wholeChar[parent.player]["stats"]["lv"]}${stat[i].value}`; stat.value = parent.wholeChar[parent.player]["stats"][stat.id];}}
                else if(stat.id == "currentHitDice"){let max = parent.wholeChar[parent.player]["stats"]["totalHitDice"]; stat.innerHTML = ""; for(let i = parseInt(parent.wholeChar[parent.player]["stats"]["lv"]); i >= 0; i--){let option = document.createElement("option"); option.innerHTML = `${i}${max}`; option.value = `${i}`; stat.appendChild(option);} stat.value = parent.wholeChar[parent.player]["stats"][stat.id];}
                else if(stat.id.includes("-btn") && !stat.id.includes("lvl")){stat.checked = false; setStats(stat);} //Stats not clicked
                else if(stat.id.includes("Save")){stat.checked = false; setStats(stat);} //Stats not clicked
                else if(["spellAbility", "lv"].includes(stat.id)){stat.value = parent.wholeChar[parent.player]["stats"][stat.id];}
                else if(stat.value == ""){stat.value = parent.wholeChar[parent.player]["stats"][stat.id]; if(!["profAndLang", "infusion", "feats", "equipment", "apperance", "characterBackstory", "ally1", "ally2", "additionalFeat&Traits", "treasure"].includes(stat.id)){stat.style.minWidth = stat.value.length + 2 + "ch";}}
                else{stat.innerHTML = parent.wholeChar[parent.player]["stats"][stat.id];}
            }

            else //stats clicked since in booleen
            {
                stat.checked = parent.wholeChar[parent.player]["stats"][stat.id];
                setStats(stat);
            }
        }

        else
        {
            if(stat.id.includes("-btn") && !stat.id.includes("lvl")){setDoc(`playerChar/${parent.player}/stats/${stat.id}`, false); }
            else{setDoc(`playerChar/${parent.player}/stats/${stat.id}`, "");}
            setStats(stat);
        }

        if(stat.id.includes("slot")){updateCheckboxes(stat.id.split("level")[1].charAt(0));}

        stat.onchange = updateStat;
        if(stat.type != "checkbox"){stat.oninput = scheduleAutosave;} //Saves after a pause in typing
    }

    for(let viewButton of viewButtons)
    {
        viewButton.onclick = showSpell;
        if(document.getElementById(viewButton.id.slice(0, viewButton.id.length - 4)).value == "")
        {
            viewButton.classList.add("invisible");
        }
    }

    for(let stat of document.getElementsByClassName("expertise")){stat.onclick = handleExpertise; stat.oncontextmenu = function(e) {e.preventDefault(); handleRightClickRoll(e, "stat");};}
    
    document.getElementById("Initiative").oncontextmenu = function(e) {e.preventDefault(); handleRightClickRoll(e, "init");};
    document.getElementById("initLabel").oncontextmenu = function(e) {e.preventDefault(); handleRightClickRoll(e, "init");};

    document.getElementById('add-hd').onclick = addNewHD;
    document.getElementById('remove-hd').onclick = removeRecentHD;
    loadMulticlassHitDice();
}

/**
 * Draws the hit-dice rows. Each row is one class: how many levels (dice) of it, the die
 * size (d4–d20), and how many of those dice are left. Rows can never add up to more than
 * the character's level; if they do, later rows are trimmed. Changing any dropdown
 * redraws the rows and saves them.
 */
function createHD(hdStateArray)
{
    let totalBox = document.getElementById("hd-div");
    let currentBox = document.getElementById("hd-current");

    currentBox.innerHTML = "";
    totalBox.innerHTML = "";

    let maxGlobalLevel = parent.wholeChar[parent.player]["stats"]["lv"];
    let standardDice = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];

    if(!hdStateArray || hdStateArray.length === 0) //If no multiclass
    {
        hdStateArray = [{ totalCount: maxGlobalLevel, dieSize: 'd8', currentCount: maxGlobalLevel }];
    }

    let allocatedLevels = 0;
    hdStateArray.forEach((group) => 
    {
        allocatedLevels += parseInt(group.totalCount) || 0;
    });

    if (allocatedLevels > maxGlobalLevel) 
    {
        let pool = maxGlobalLevel;
        hdStateArray.forEach((group) => 
        {
            group.totalCount = Math.min(group.totalCount, pool);
            pool -= group.totalCount;
            if (group.totalCount < 1 && pool === 0) group.totalCount = 0; // handle trailing entries safely
            group.currentCount = Math.min(group.currentCount, group.totalCount);
        });
    }

    // Pass 2: Draw components onto the page matching layout rules
    let cumulativeUsed = 0;
    hdStateArray.forEach((classGroup, index) => {
        // Skip drawing rendering elements for fully dead tracking slots
        if (index > 0 && classGroup.totalCount === 0 && hdStateArray.length > 1) return;

        // Calculate maximum allowable selection for this row item without breaking overall character max limit
        const otherRowsAllocated = hdStateArray.reduce((acc, g, i) => acc + (i !== index ? g.totalCount : 0), 0);
        const maxRowAllocation = Math.max(1, maxGlobalLevel - otherRowsAllocated);

        // --- Render Total Configurations Column Section ---
        const totalRow = document.createElement('div');
        totalRow.className = 'hd-total-row-item';
        totalRow.style.margin = '4px 0';
        totalRow.dataset.index = index;

        let totalOptions = '';
        for (let i = 1; i <= maxRowAllocation; i++) {
            totalOptions += `<option value="${i}" ${classGroup.totalCount == i ? 'selected' : ''}>${i}</option>`;
        }

        let dieOptions = '';
        standardDice.forEach(die => {
            dieOptions += `<option value="${die}" ${classGroup.dieSize === die ? 'selected' : ''}>${die}</option>`;
        });

        totalRow.innerHTML = `
            <select class="hd-total-select" style="width: 45px; text-align: center;">${totalOptions}</select>
            <select class="hd-die-select" style="width: 55px; margin-left: 2px;">${dieOptions}</select>
        `;
        totalBox.appendChild(totalRow);

        // --- Render Current Remaining Selector Column Section ---
        const currentRow = document.createElement('div');
        currentRow.className = 'hd-current-row-item';
        currentRow.style.margin = '4px 0';
        currentRow.style.display = "inline";
        currentRow.dataset.index = index;

        let currentOptions = '';
        for (let i = classGroup.totalCount; i >= 0; i--) {
            // Displays with custom dynamic text formatting (e.g., "6d8", "0d6") matching your setup design
            currentOptions += `<option value="${i}" ${classGroup.currentCount == i ? 'selected' : ''}>${i}${classGroup.dieSize}</option>`;
        }

        currentRow.innerHTML = `
            <select class="hd-current-select" style="width: 70px; text-align: center;">${currentOptions}</select>
        `;
        currentBox.appendChild(currentRow);

        // --- Bind Listener Logic Rules ---
        const totalSelect = totalRow.querySelector('.hd-total-select');
        const dieSelect = totalRow.querySelector('.hd-die-select');
        const currentSelect = currentRow.querySelector('.hd-current-select');

        // Handle cascading structural changes across rows when levels are modified
        totalSelect.onchange = function() {
            classGroup.totalCount = parseInt(this.value);
            classGroup.currentCount = Math.min(classGroup.currentCount, classGroup.totalCount);
            // Re-evaluate entire stack array to apply updated calculations to neighboring elements
            createHD(serializeHDInterface());
            commitHDStateToDatabase();
        };

        // Re-draw dropdown labels immediately when the selected die format changes
        dieSelect.onchange = function() {
            classGroup.dieSize = this.value;
            createHD(serializeHDInterface());
            commitHDStateToDatabase();
        };

        currentSelect.onchange = function() {
            commitHDStateToDatabase();
        };
    });
}

/**
 * "+" next to hit dice: adds another class row (1 level of d6) for multiclassing,
 * unless the levels already add up to the character's level.
 */
function addNewHD() 
{
    const dynamicStack = serializeHDInterface();
    const maxAllowedLevel = parent.wholeChar[parent.player]["stats"]["lv"];
    
    let currentAllocatedSum = 0;
    dynamicStack.forEach(g => currentAllocatedSum += g.totalCount);

    // Stop adding rows if the level budget is already fully spent
    if (currentAllocatedSum >= maxAllowedLevel) {
        alert("Cannot add multiclass hit dice: Total combined levels already equal your character level.");
        return;
    }

    dynamicStack.push({ totalCount: 1, dieSize: 'd6', currentCount: 1 });
    createHD(dynamicStack);
    commitHDStateToDatabase();
}

/**
 * "-" next to hit dice: removes all multiclass rows, back to one row covering every level.
 */
function removeRecentHD() 
{
    const baseCap = parent.wholeChar[parent.player]["stats"]["lv"];
    const baselineCollection = [{ totalCount: baseCap, dieSize: 'd6', currentCount: baseCap }];
    createHD(baselineCollection);
    commitHDStateToDatabase();
}

/**
 * Reads the hit-dice rows back out of the page into a list of
 * { totalCount, dieSize, currentCount } objects.
 */
function serializeHDInterface() 
{
    const totalRowElements = document.querySelectorAll('.hd-total-row-item');
    const currentRowElements = document.querySelectorAll('.hd-current-row-item');
    const stateOutputArray = [];
    
    totalRowElements.forEach((totalRow, idx) => {
        const correspondingCurrentRow = currentRowElements[idx];
        if (correspondingCurrentRow) {
            stateOutputArray.push({
                totalCount: parseInt(totalRow.querySelector('.hd-total-select').value) || 1,
                dieSize: totalRow.querySelector('.hd-die-select').value || 'd8',
                currentCount: parseInt(correspondingCurrentRow.querySelector('.hd-current-select').value) || 0
            });
        }
    });
    
    return stateOutputArray;
}

/**
 * Saves the current hit-dice rows to stats/multiclassHitDice.
 */
function commitHDStateToDatabase() 
{
    const valuesPayload = serializeHDInterface();
    // Formulates character reference node paths mirroring your standard setDoc setup
    setDoc(`playerChar/${parent.player}/stats/multiclassHitDice`, valuesPayload);
}

/**
 * Draws the hit dice from what's saved (or one default row if nothing is saved yet).
 */
function loadMulticlassHitDice() 
{
    if (parent.wholeChar[parent.player] && parent.wholeChar[parent.player]["stats"]) 
    {
        const cloudRecord = parent.wholeChar[parent.player]["stats"]["multiclassHitDice"];
        createHD(cloudRecord);
    } 
    
    else 
    {
        createHD(null);
    }
}

/**
 * Draws the spell-slot icons for one spell level: as many as the slot-count box says.
 * Each is a hidden checkbox + a label showing the slot picture (CSS swaps in the "used"
 * picture when checked). Each slot's used/unused state is saved on its own.
 */
function updateCheckboxes(level)
{
    let input = document.getElementById(`level${level}-slot`);
    let display = document.getElementById(`level${level}-slot-display`);

    if(!input || !display){return;}

    let count = parseInt(input.value) || 0;
    display.innerHTML = "";

    for(let i = 0; i < count; i++)
    {
        let id = `level${level}-cb-${i}`;
        
        let box = document.createElement('input');
        box.type = 'checkbox';
        box.id = id;
        box.style.display = "none";
        box.className = "spell-check-hidden";

        if(parent.wholeChar[parent.player]["stats"][id] == true || parent.wholeChar[parent.player]["stats"][id] == false)
        {
            box.checked = parent.wholeChar[parent.player]["stats"][id];
        }

        else
        {
            setDoc(`playerChar/${parent.player}/stats/${id}`, false);
        }

        box.onchange = function(){setDoc(`playerChar/${parent.player}/stats/${id}`, box.checked);};

        let label = document.createElement('label');
        label.setAttribute("for", id);
        label.className = 'spell-slot-label';
        
        display.appendChild(box);
        display.appendChild(label);
    }
}

/**
 * Works out and shows the bonus for one skill or saving throw from its "-btn" checkbox:
 * the ability modifier, + proficiency if ticked, + proficiency again with expertise.
 * Bards add half proficiency to skills they aren't proficient in (Jack of All Trades).
 */
function setStats(stat)
{
    if(stat.id.includes("-btn") && !stat.id.includes("lvl"))
    {
        let display;
        let skill;
        let modifier;
        let exper;

        if(stat.id.includes("Save-btn"))
        {
            skill = stat.id.slice(0, stat.id.length-8);
            modifier = parent.wholeChar[parent.player]["stats"][skill];
            display = document.getElementById(skill + "Save");
            exper = skill + "Save";
        }

        else
        {
            skill = stat.id.slice(0, stat.id.length-4);
            let base6 = skillDecrypt[skill];
            modifier = parent.wholeChar[parent.player]["stats"][base6];
            display = document.getElementById(skill);
            exper = skill;
        }

        if(stat.checked)
        {
            modifier = parseInt(modifier) + parseInt(parent.wholeChar[parent.player]["stats"]["proficiency"]);

            if(parent.wholeChar[parent.player]["stats"][`${exper}-expertise`]){modifier += parseInt(parent.wholeChar[parent.player]["stats"]["proficiency"]);}
        }
        
        else if(!stat.checked && parent.wholeChar[parent.player]["stats"]["class"].toLowerCase().includes("bard")) //Jack of All Trades
        {
            modifier = parseInt(modifier) + Math.floor(parseInt(parent.wholeChar[parent.player]["stats"]["proficiency"]) / 2);
        }

        modifier = statFormat(modifier);
        setDoc(`playerChar/${parent.player}/stats/${stat.id.slice(0, stat.id.length-4)}`, modifier);
        display.innerHTML = toTitleCase(skill + ": " + modifier);
        if(parent.wholeChar[parent.player]["stats"][`${exper}-expertise`]){display.innerHTML += " <strong>(Expertise)</strong>"}
    }
}

/**
 * Clicking a proficient skill's name toggles expertise for it, then redraws the sheet.
 */
function handleExpertise()
{
    let stat = this.id;
    let button = document.getElementById(stat + "-btn");

    if(button.checked)
    {
        if(parent.wholeChar[parent.player]["stats"][`${stat}-expertise`])
        {
            deleteDoc(`playerChar/${parent.player}/stats/${stat}-expertise`);
        }

        else
        {
            setDoc(`playerChar/${parent.player}/stats/${stat}-expertise`, true);
        }

        setTimeout(init, 1000);
    }
}

/**
 * Runs when any sheet field changes, and saves it. Special cases:
 *   checkboxes        -> save true/false and recalculate that bonus
 *   multi-line boxes  -> each line gets a "•" bullet
 *   ability scores    -> recalculate and save the modifier
 *   AC / HP fields    -> also update the player's token on the map
 *   spell boxes       -> show or hide the eye icon
 *   spell-slot counts -> redraw the slot icons
 * Text boxes also grow to fit what was typed.
 */
function updateStat()
{
    autosaveWaiting.delete(this); //Saved properly below
    let setTo = this.value;

    if(setTo == "on")
    {
        setTo = this.checked;
        setStats(this);
    }

    else if(setTo.includes("\n"))
    {
        setTo = setTo.split("\n");

        for(let i = 0; i < setTo.length; i++)
        {
            if(setTo[i][0] != "•" && setTo[0] != " " && setTo[i][0] != " "){setTo[i] = "•   " + setTo[i];} 
            if(setTo[i] == "•   "){setTo[i] = "";}
        }

        setTo = setTo.join("\n");

        this.value = setTo;
    }

    else if(this.classList.contains("base6"))
    {
        let full = this.value;
        let smaller;
        let ref = document.getElementById(this.id.slice(0, this.id.length-4));

        full = parseInt(full);
        smaller = (full - 10) / 2;
        smaller = statFormat(Math.floor(smaller));
        ref.innerHTML = smaller;
        setDoc(`playerChar/${parent.player}/stats/${this.id.slice(0, this.id.length-4)}`, smaller);
        setTimeout(init, 1000);
    }

    else if(["lv", "spellAbility", "totalHitDice"].includes(this.id)){setTimeout(init, 1000);}

    else if(["AC", "currentHp", "maxHp", "tempHp"].includes(this.id))
    {
        setDoc(`playerChar/${parent.player}/token/${this.id}`, setTo);
        setDoc(`currentMap/${parent.player}/${this.id}`, setTo);
        this.style.minWidth = this.value.length + 2 + "ch";
    }

    else
    {
        if(!["profAndLang", "infusion", "feats", "equipment", "apperance", "characterBackstory", "ally1", "ally2", "additionalFeat&Traits", "treasure"].includes(this.id)){this.style.minWidth = this.value.length + 2 + "ch";}
    }

    setDoc(`playerChar/${parent.player}/stats/${this.id}`, setTo);

    if(this.id.includes("lvl") || this.id.includes("can"))
    {
        if(setTo != "")
        {
            document.getElementById(this.id + "-See").classList.remove("invisible");
        }

        else
        {
            document.getElementById(this.id + "-See").classList.add("invisible");
        }
    }

    if(this.id.includes("slot"))
    {
        updateCheckboxes(this.id.split("level")[1].charAt(0));
    }
}

/**
 * Eye icon next to a spell: if the spell is in the site's spell list, shows its details
 * on a card; otherwise opens it on Roll20's compendium in a frame.
 */
function showSpell()
{
    let spellName = toTitleCase(document.getElementById(this.id.slice(0, this.id.length - 4)).value);
    let link;
    let spellLevel = this.id;

    if(spellLevel.includes("can")){spellLevel = "0";}
    else{spellLevel = spellLevel.slice(3, 4);}

    if(spellName != "")
    {
        //Shown on the dashboard itself (not inside this zoomed sheet), so it's full size
        let spell = parent.wholeSpells?.[spellLevel]?.[spellName];

        if(spell)
        {
            let line = (label, value) => `<p class="card-text">${label}: ${value}</p>`;
            showPopup({boxClass: "popupSpell", html:
                `<div class="card-body notes">
                    <h5 class="card-title">${spell["name"]}</h5>
                    ${line("Cast Time", spell["castTime"])}
                    ${line("Range", spell["range"])}
                    ${line("Components", spell["components"])}
                    ${line("Duration", spell["duration"])}
                    ${spell["concentration"] == "true" ? `<p class="card-text">Concentration</p>` : ""}
                    <p class="card-text">${spell["description"]}</p>
                </div>`});
        }

        else
        {
            //Not in the site's spell list: open it on Roll20 in a tall box
            link = `https://roll20.net/compendium/dnd5e/${encodeURIComponent(spellName)}`;
            showPopup({boxClass: "popupTall", title: spellName, html: `<iframe class="popupFrame" src="${link}" title="${spellName}"></iframe>`});
        }
    }
}

/* ------------------------------------------------------------------------------------ *
 *  Autosave                                                                             *
 *  Typing saves on its own 1.5 seconds after the last key, and straight away if the     *
 *  page is closed or hidden, so nothing is lost when someone closes the tab without     *
 *  clicking out of a box. It saves exactly what's typed; the usual tidy-up (bullets,    *
 *  recalculated modifiers) still happens when they click out of the box.                *
 * ------------------------------------------------------------------------------------ */
const AUTOSAVE_DELAY = 1500;
let autosaveTimer = null;
let autosaveWaiting = new Set(); //Boxes typed in since their last save

function scheduleAutosave()
{
    autosaveWaiting.add(this);
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_DELAY);
}

function autosaveNow()
{
    clearTimeout(autosaveTimer);

    for(let box of autosaveWaiting)
    {
        let value = box.value;
        setDoc(`playerChar/${parent.player}/stats/${box.id}`, value);

        //HP and AC also show on the map token
        if(["AC", "currentHp", "maxHp", "tempHp"].includes(box.id))
        {
            setDoc(`playerChar/${parent.player}/token/${box.id}`, value);
            setDoc(`currentMap/${parent.player}/${box.id}`, value);
        }
    }

    autosaveWaiting.clear();
}

//Closing the tab, switching tabs or leaving the page: save whatever is waiting now
window.addEventListener("pagehide", autosaveNow);
document.addEventListener("visibilitychange", () => {if(document.visibilityState == "hidden"){autosaveNow();}});
try{parent.addEventListener("pagehide", autosaveNow);}catch(e){}

/**
 * Closes the spell popup.
 */
function handleExit()
{
    document.getElementById("spellFrame").classList.add("invisible");
}

/**
 * Right-click roll. Rolls a d20 plus the bonus shown on the clicked skill (or the
 * Initiative box), posts the result to Discord and shows it. If the DM has asked for
 * that exact save/check, it's sent as the answer to the DM's request instead.
 */
function handleRightClickRoll(e, type)
{
    let clicked = e.currentTarget.id
    let modifier;
    let mod;

    switch(type)
    {
        case "stat": 
            if(e.currentTarget.innerHTML.includes("+"))
            {
                modifier = e.currentTarget.innerHTML.slice(e.currentTarget.innerHTML.indexOf("+"));
            }
            
            else
            {
                modifier = e.currentTarget.innerHTML.slice(e.currentTarget.innerHTML.indexOf("-"));
            }
            break;

        case "init":
            modifier = document.getElementById("Initiative").value;
            clicked = "Initiative";
            break;
    }

    mod = parseInt(modifier);

    if(clicked == parent.saveOrCheck)
    {
        let token = parent.wholeDB[parent.player];
        parent.handleUseAction([token], "{@respond}");
        return false;
    }

    let random = Math.random();
    let roll = Math.floor(random * (20)) + mod + 1; //Gives random roll
    let message = `${parent.player} had rolled (${roll-mod})${modifier} = **${roll}** for ${toTitleCase(clicked)}.`;

    sendDiscordMessage(message);
    alert(`Rolled (${roll-mod})${modifier} = **${roll}** for ${toTitleCase(clicked)}.`);

    return false;
}
