/**
 * viMethods.js — the shared toolbox. Almost every other script imports from here.
 *
 *   • Connects to Firebase (database, login, file storage) and exports `auth`,
 *     `database` and `storage` for everyone else.
 *   • setDoc / deleteDoc: the one way the site writes to the database.
 *   • sendDiscordMessage: posts a roll or action to the Discord channel AND to the
 *     dashboard's Display feed.
 *   • Small helpers: toTitleCase, statFormat (+3 / -1), wait, reload, createCard, etc.
 *   • setMapValue: the pixel maths for placing tokens on the 26×26 battle-map grid.
 *   • Campaigns: one database holds several campaigns (see "Campaigns" below). Every page
 *     waits here until it knows which campaign is live and which character this login
 *     plays in it, and every database path is pointed at that campaign automatically.
 *
 * Note: the Firebase config below is meant to be public (all web apps ship it);
 * what protects the data is the database's security rules, not this key.
 */


"use strict";
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js';
import { getDatabase, ref, set, get, onValue } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-database.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js';
import { getStorage, uploadBytes, getDownloadURL, ref as sRef } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-storage.js";

// Firebase project settings. Every page that imports this file shares this one connection.
// (Exported so the DM site can open a second connection to create logins without
// signing the DM out.)
export const firebaseConfig =
({
    apiKey: "AIzaSyArcsmJkXSeuIHMysYtIzRdjIDlKNQA25Y",
    authDomain: "forgottenrealmsmap.firebaseapp.com",
    projectId: "forgottenrealmsmap",
    storageBucket: "forgottenrealmsmap.appspot.com",
    messagingSenderId: "697902154695",
    appId: "1:697902154695:web:ffa5c47817f3097c89cfe2",
    measurementId: "G-Q2W494NRDT",
    storageBucket: "gs://forgottenrealmsmap.firebasestorage.app"
});
const firebaseApp = initializeApp(firebaseConfig); //Connects to database

export let auth = getAuth(); //Logs into accounts
export let database = getDatabase(); //Sets up connection
export let storage = getStorage(firebaseApp);
export let quickAction = false;

/* ------------------------------------------------------------------------------------ *
 *  Campaigns                                                                           *
 *                                                                                      *
 *  The database root:                                                                  *
 *    files/            pictures, token categories... shared by every campaign          *
 *    logins/<Login>    every login the DM has set up (true)                            *
 *    campaignList/<id> {name}  every campaign                                          *
 *    activeCampaign    the id of the live campaign; everyone's pages follow it         *
 *    campaigns/<id>/   everything else for that campaign: currentMap, playerChar,      *
 *                      preset, saved maps... plus players/<Login> = <character key>    *
 *                                                                                      *
 *  A login is the person (Ben); their character differs per campaign (Ben plays Ben in *
 *  Infused, Jane in Drunk). `character` is the key under playerChar/ for this login in *
 *  the live campaign; the old "player" name everywhere in the code means this.         *
 *  Vi is the DM in every campaign.                                                     *
 * ------------------------------------------------------------------------------------ */

/** Top-level database sections that are shared, not per campaign. */
export const SHARED_PATHS = ["files", "logins", "campaignList", "activeCampaign", "campaigns"];
export const DEFAULT_CAMPAIGN = "infused";
export const DM_LOGIN = "Vi";

export let campaign = null;         //Id of the live campaign (null when nobody is logged in)
export let login = null;            //Who is logged in, e.g. "Ben"
export let character = null;        //Their character key in the live campaign, e.g. "Jane" (null = none yet)
export let campaignPlayers = {};    //campaigns/<campaign>/players: login -> character

/**
 * The real database path for a path the site uses. Shared sections stay as they are;
 * everything else goes under campaigns/<live campaign>/.
 *   dbPath("currentMap/goblin")  -> "campaigns/drunk/currentMap/goblin"
 *   dbPath("files/tokens")       -> "files/tokens"
 */
export function dbPath(path)
{
    let clean = String(path ?? "").replace(/^\/+/, "");
    let top = clean.split("/")[0];
    if(SHARED_PATHS.includes(top) || campaign == null){return clean;}
    return clean == "" ? `campaigns/${campaign}` : `campaigns/${campaign}/${clean}`;
}

/**
 * A database reference for a site path (use instead of ref(database, path)).
 */
export function dbRef(path)
{
    return ref(database, dbPath(path));
}

/**
 * The login name from a Firebase user ("Ben@ForgottenRealms.com" -> "Ben").
 */
export function loginName(user)
{
    return user?.email ? toTitleCase(user.email.split("@")[0]) : null;
}

/**
 * Pages that shouldn't reload when this login's character changes (the character
 * selection page sets it itself) call this.
 */
export function holdCampaignReload()
{
    window.campaignReloadHeld = true;
}

// Wait for Firebase to restore the login, then look up the live campaign and this
// login's character in it. Every script that imports this file waits for this.
const signedInUser = await new Promise((resolve) =>
{
    const stop = onAuthStateChanged(auth, (user) => {stop(); resolve(user);});
});

if(signedInUser)
{
    login = loginName(signedInUser);

    try
    {
        campaign = (await get(ref(database, "activeCampaign"))).val() || DEFAULT_CAMPAIGN;
        campaignPlayers = (await get(ref(database, `campaigns/${campaign}/players`))).val() ?? {};
    }

    catch(error)
    {
        console.error("Couldn't read the live campaign:", error);
        campaign = campaign ?? DEFAULT_CAMPAIGN;
    }

    character = login == DM_LOGIN ? DM_LOGIN : (campaignPlayers[login] ?? null);
    window.campaign = campaign;
    window.login = login;

    // Everyone follows the DM's campaign switch
    onValue(ref(database, "activeCampaign"), (snapshot) =>
    {
        if((snapshot.val() || DEFAULT_CAMPAIGN) != campaign){safeReload("the live campaign changed");}
    });

    // The DM changed which character this login plays here
    onValue(ref(database, `campaigns/${campaign}/players/${login}`), (snapshot) =>
    {
        let now = login == DM_LOGIN ? DM_LOGIN : (snapshot.val() ?? null);
        if(now != character && !window.campaignReloadHeld){safeReload("your character in this campaign changed");}
    });

    // No character in this campaign yet: make one on the character selection page
    let page = location.pathname.split("/").pop();
    if(character == null && page != "selection.html" && page != "loginPage.html")
    {
        location.href = "selection.html";
    }
}
// Which ability score each skill uses (e.g. stealth -> Dexterity). Used when working out skill bonuses.
export let skillDecrypt = {"athletics" : "Strength", "acrobatics" : "Dexterity", "slightOfHand" : "Dexterity", "stealth" : "Dexterity", "arcana" : "Intelligence", "history" : "Intelligence", "investigation" : "Intelligence", "nature" : "Intelligence", "religion" : "Intelligence", "animalHandling" : "Wisdom", "insight" : "Wisdom", "medicine" : "Wisdom", "perception" : "Wisdom", "survival" : "Wisdom",  "deception" : "Charisma",  "intimidation" : "Charisma",  "performance" : "Charisma",  "persuasion" : "Charisma"};

/**
 * Uploads an image the player picked: compresses it (max ~0.4 MB, 1024px) in the browser,
 * stores it in Firebase Storage at `structure`, then saves the public download link
 * in the database. `type` says what the image is for (currently only "portrait").
 */
export async function handleImageUpload(event, structure, type)
{
    if(event.target.files)
    {
        let imageFile = event.target.files[0];
        
        const options = {
            maxSizeMB: 0.4,          // Max size 200KB (Perfect for tokens/sheets)
            maxWidthOrHeight: 1024, // Keeps it crisp but not massive
            useWebWorker: true
        };

        try {
            console.log("Compressing...");
            const compressedFile = await imageCompression(imageFile, options);
            
            // --- STEP 2: UPLOAD TO STORAGE ---
            // Saving it as the player's name ensures they only ever have ONE file (saves space)
            const storageRef = sRef(storage, structure);
            
            const snapshot = await uploadBytes(storageRef, compressedFile);
            
            // --- STEP 3: GET THE PERMANENT URL ---
            const downloadURL = await getDownloadURL(snapshot.ref);
            
            // --- STEP 4: UPDATE FIREBASE REALTIME DB ---
            // This ensures the "Source of Truth" is updated for everyone
            switch(type)
            {
                case "portrait":
                    setDoc(`playerChar/image`, downloadURL);
                    document.getElementById("portrait").src = downloadURL;
                    document.getElementById("portrait").style.display = "block";
                    break;
            }
        } 
        
        catch (error) 
        {
            alert("Upload failed:", error);
        }
    }
}

/**
 * Turns "quick action" mode on or off. In that mode createCard() makes compact buttons
 * instead of full parchment cards (used by the Quick Action overlay).
 */
export function setQuickAction(bool)
{
    quickAction = bool;
}

/**
 * Works out where each grid square is, in pixels, on the battle map.
 * The map image is 26×26 squares (A–Z down, 1–26 across). `pos[i]` is the pixel offset
 * of column/row i. The "bumper" and "movement" numbers were tuned by hand for each
 * Bootstrap screen-size breakpoint so tokens land exactly on the squares.
 * Returns everything in one object, used by map.js and mapControler.js.
 */
export function setMapValue()
{
    const body = document.querySelector("body"); //gridMap
    const rect = body.getBoundingClientRect();
    let trueMapSize = 2030;
    let mapSize = (trueMapSize * (8 / 10));
    let bumper = Math.round(trueMapSize / 26) * 0.011;
    let distance = Math.round(mapSize / 26);
    let movement = distance * 1.18999999999999999;
    let bubble = 35;

    if(screen.width < 576)
    {
        bumper = Math.round(trueMapSize / 26) * 0.149;
        movement = distance * 1.290059;
    }

    else if(screen.width < 768)
    {
        bumper = Math.round(trueMapSize / 26) * 0.139999;
        movement = distance * 1.290319999;
    }
 
    else if(screen.width < 992)
    {
        bumper = Math.round(trueMapSize / 26) * 0.1299999;
        movement = distance * 1.2899999;
    }

    else if(screen.width < 1200)
    {
        bumper = Math.round(trueMapSize / 26) * 0.04244;
        movement = distance * 1.1799;
    }

    else if(screen.width < 1400)
    {
        bumper = Math.round(trueMapSize / 26) * 0.04235;
        movement = distance * 1.1933183;
    }

    let disAndBum = distance + bumper;
    disAndBum = parseInt(disAndBum);
    movement = parseInt(movement);
    let pos = [disAndBum, disAndBum + movement, disAndBum + (movement * 2), disAndBum + (movement * 3), disAndBum + (movement * 4), disAndBum + (movement * 5), disAndBum + (movement * 6), disAndBum + (movement * 7), disAndBum + (movement * 8), disAndBum + (movement * 9), disAndBum + (movement * 10), disAndBum + (movement * 11), disAndBum + (movement * 12), disAndBum + (movement * 13), disAndBum + (movement * 14), disAndBum + (movement * 15), disAndBum + (movement * 16), disAndBum + (movement * 17), disAndBum + (movement * 18), disAndBum + (movement * 19), disAndBum + (movement * 20), disAndBum + (movement * 21), disAndBum + (movement * 22), disAndBum + (movement * 23), disAndBum + (movement * 24), disAndBum + (movement * 25)];
    let yPos = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];
    let xPos = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26"];
    
    let map = {"trueMapSize" : trueMapSize, "mapSize" : mapSize, "bumper" : bumper, "distance" : distance, "movement" : movement, "disAndBum" : disAndBum, "pos" : pos, "xPos" : xPos, "yPos" : yPos, "bubble" : bubble};
    return map;
}

/**
 * Capitalises the first letter of every word: "help me" -> "Help Me".
 * Used wherever names are shown, since many are typed or stored in lower case.
 */
export function toTitleCase(word)
{
    let finalWord = "";
    if(word.includes(" ")) //More than one word
    {
        word = word.split(" "); 
        
        for(let singleWord of word)
        {
            if(singleWord != ""){finalWord += `${singleWord[0].toUpperCase() + singleWord.slice(1)} `;} //Capitilize each word in the varible
        }
        
        finalWord = finalWord.slice(0, finalWord.length - 1);
    }

    else //If only one word given
    {
        if(word[0])
        {
            finalWord = word[0].toUpperCase() + word.slice(1); //Caps the one word
        }
    }

    return finalWord;
}

/**
 * Builds a card and adds it to the element with id `location`.
 *   title: card heading
 *   text:  array of lines; each becomes its own paragraph
 * Normally a parchment card ("card notes"); in quick-action mode a small button instead.
 */
export function createCard(title, text, location)
{
    if(!quickAction)
    {   
        let cardDiv = document.createElement("div");
        cardDiv.setAttribute("class", "card notes");
        let cardBody = document.createElement("div");
        cardBody.setAttribute("class", "card-body notes");
        let cardTitle = document.createElement("h5");
        cardTitle.setAttribute("class", "card-title");
        cardTitle.innerHTML = title;
        cardBody.appendChild(cardTitle);

        for(let i = 0; i < text.length; i++) //For each sentence in the card
        {
            let cardText = document.createElement("p");
            cardText.setAttribute("class", "card-text");
            cardText.style.margin = "3px";
            cardText.innerHTML = text[i];
            cardBody.appendChild(cardText);
        }
        
        let noteDisplay = document.getElementById(location);
        noteDisplay.appendChild(cardDiv);
        cardDiv.appendChild(cardBody);
    }
    
    else
    {
        let card = document.createElement("button");
        card.classList = "center gridButton card-body text-brass bg-oak";
        card.innerHTML = title;

        let noteDisplay = document.getElementById(location);
        noteDisplay.appendChild(card); 
    }
}

/**
 * Writes `toChange` to the database at `path`, replacing whatever was there.
 * Every save on the site goes through here (e.g. setDoc("currentMap/Ben/currentHp", "12")).
 * Paths are for the live campaign (see dbPath): "currentMap/..." saves into it, while
 * shared sections like "files/..." save at the top.
 */
export function setDoc(path, toChange)
{
    return set(dbRef(path), toChange); 
}

/**
 * Deletes whatever is stored at `path` in the database (by setting it to null).
 */
export function deleteDoc(path)
{
    return set(dbRef(path), null);
}

/**
 * Picks the little health-bar picture shown under a token.
 * Temp HP shows its own bar; otherwise the bar steps down at 100%, 80%, 60%, 40%, above 0 and 0.
 * Max and current both "0" means "don't show a bar" (used for objects).
 */
export function returnHpImage(maxHp, tempHp, currentHp)
{
    let fraction = parseInt(currentHp) / parseInt(maxHp);

    if(tempHp != null)
    {
        if(tempHp != "0")
        {
            return window.top.parent.imgs["hpBar"]["tempHp"];
        }
    }

    if(maxHp == "0" && currentHp == "0")
    {
        return window.top.parent.imgs["hpBar"]["invisible"];
    }

    else if(fraction == 1)
    {
        return window.top.parent.imgs["hpBar"]["hpBar1"];
    }

    else if(fraction >= .8)
    {
        return window.top.parent.imgs["hpBar"]["hpBar2"];
    }

    else if(fraction >= .6)
    {
        return window.top.parent.imgs["hpBar"]["hpBar3"];
    }

    else if(fraction >= .4)
    {
        return window.top.parent.imgs["hpBar"]["hpBar4"];
    }

    else if(fraction > 0)
    {
        return window.top.parent.imgs["hpBar"]["hpBar5"];
    }

    else if(fraction == 0)
    {
        return window.top.parent.imgs["hpBar"]["hpBar6"];
    }  
}

/**
 * Basic safety check on text typed by players before it's used to build page content.
 * Removes spaces, swaps double quotes/backticks for single quotes, and rejects (returns null,
 * with an alert) anything containing < > ; @ ( ).
 */
export function clenseInput(toClense)
{
    let badChars = ["<", ">", ";", "@", "(", ")"];
    let isOk = true;

    toClense = toClense.replaceAll(" ", "");
    toClense = toClense.replaceAll("\"", "\'");
    toClense = toClense.replaceAll("\`", "\'");

    for(let bad of badChars)
    {
        if(toClense.includes(bad)) //If the input contains a bad char
        {
            alert(`Bad char detected: ${bad}. Please remove the char and try again.`);
            isOk = false;
        }
    }

    if(isOk)
    {
        return toClense;
    }

    else
    {
        return null;
    }
}

/**
 * Shows a modifier the D&D way: 3 -> "+3", 0 -> "+0", -1 -> "-1".
 */
export function statFormat(stat)
{
    stat = parseInt(stat);

    if(stat >= 0)
    {
        return "+" + stat;
    }

    else
    {
        return `${stat}`;
    }
}

/**
 * Runs `fun` after `seconds` seconds.
 */
export function wait(seconds, fun)
{
    setTimeout(fun, seconds * 1000);
}

/**
 * Reloads the page after `seconds` seconds (lets a database write finish first).
 */
export function reload(seconds)
{
    wait(seconds, function(){location.reload();})
}

/**
 * Reloads the page, unless this tab has already reloaded itself several times in the
 * last few seconds. Then it stops, shows `reason` in a red bar at the top of the page
 * and logs it to the console, so a page can never get stuck reloading forever.
 */
export function safeReload(reason)
{
    let now = Date.now();
    let log = [];
    try{log = JSON.parse(sessionStorage.getItem("autoReloads") || "[]").filter((time) => now - time < 20000);}catch(e){}

    if(log.length >= 3)
    {
        console.error("Stopped an automatic reload loop:", reason);

        if(!document.getElementById("reloadLoopNotice"))
        {
            let notice = document.createElement("div");
            notice.id = "reloadLoopNotice";
            notice.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#8b1e1e;color:#fff;padding:8px 12px;font:15px sans-serif;text-align:center;";
            notice.textContent = `The page kept reloading, so it has stopped (${reason}). Refresh to try again.`;
            document.body.appendChild(notice);
        }
        return;
    }

    log.push(now);
    try{sessionStorage.setItem("autoReloads", JSON.stringify(log));}catch(e){}
    location.reload();
}

/**
 * A token title (" Mistah, Infused, Nook,") with `name` in it. The first name in a title is
 * whose token it is: players can only take control of tokens whose title names them
 * (their summons), so their own token's title must name them too. Blank or "." titles
 * become just the name.
 */
export function titleWithName(title, name)
{
    let parts = String(title ?? "").split(",").map((part) => part.trim()).filter((part) => part != "" && part != ".");
    if(name && !parts.includes(name)){parts.unshift(name);}
    return parts.length ? " " + parts.join(", ") + "," : " ";
}

/**
 * A map row moved by `offset` squares: "M" + 2 -> "O" (rows are the letters A-Z),
 * kept on the 26-row board.
 */
export function shiftRow(row, offset)
{
    let index = String(row ?? "A").toUpperCase().charCodeAt(0) - 65;
    if(isNaN(index) || index < 0 || index > 25){index = 0;}
    return String.fromCharCode(65 + Math.min(25, Math.max(0, index + offset)));
}

/**
 * True if `key` can be used as a database key (Firebase doesn't allow . # $ [ ] / or blank).
 */
export function isValidKey(key)
{
    return typeof key == "string" && key.trim() != "" && !/[.#$\[\]\/]/.test(key);
}

/**
 * Inserts `elemToPlace` into the page directly before `referenceElement`.
 */
export function placeBefore(elemToPlace, referenceElement)
{ 
    referenceElement.parentElement.insertBefore(elemToPlace, referenceElement);
}

/**
 * Makes a small inline "Name:" label (an <h6>) for building forms in code.
 */
export function createLabel(name)
{
    let label = document.createElement("h6");
    label.innerHTML = `${name}:`;
    label.style.display = "inline";
    label.style.margin = "5px";
    return label;
}

/**
 * Returns a random entry from `list`.
 */
export function getRandomItem(list)
{
    let randomIndex = Math.floor(Math.random() * list.length);
    return list[randomIndex];
}

/**
 * Announces something to the table: posts `message` to the Discord channel through
 * the webhook saved in the database (playerChar/Vi/testingWebhook) and also adds it to
 * the dashboard's Display feed. The ||   || line is a Discord spoiler bar used as a divider.
 */
export function sendDiscordMessage(message)
{
    sendMessageToDisplay(message);
    message = message + "\n\n ||                ||"; //Makes message seperating bars
    const contents = `${message}`;
    const request = new XMLHttpRequest();
    request.open("POST", window.top.parent.wholeChar["Vi"]["testingWebhook"]); //Opens the webhook
    request.setRequestHeader("Content-type", "application/json"); //Gives json header
    const prams = 
    {
        content: contents
    } 
    request.send(JSON.stringify(prams)); //Sends message
}

/**
 * Adds a message to the Display feed's 10-slot circular buffer (display/0–9):
 * moves display/current forward one slot (9 wraps back to 0) and writes the message there.
 */
function sendMessageToDisplay(message)
{
    let current = parseInt(window.top.parent.wholeDisplay["current"]);

    if(current + 1 > 9)
    {
        setDoc("display/current", "0");
        current = 0;
    }

    else
    {
        setDoc("display/current", `${current + 1}`);
        current++;
    }

    setDoc(`display/${current}`, message);
}

/* ------------------------------------------------------------------------------------ *
 *  Token picture categories                                                            *
 *                                                                                      *
 *  Every token picture is still listed in files/tokens/<name> (its link), which is     *
 *  where tokens look up their picture. Categories are a separate label list:           *
 *      files/tokenCategories/<name> = "Furniture"                                      *
 *  A picture with no label counts as "Uncategorized".                                  *
 * ------------------------------------------------------------------------------------ */

export const UNCATEGORIZED = "Uncategorized";
export const CHARACTER_CATEGORY = "Characters";
export const ALL_CATEGORIES = "All";

/**
 * The category of one token picture (from the files/ data, e.g. window.imgs).
 */
export function tokenCategory(imgs, name)
{
    let category = imgs?.["tokenCategories"]?.[name];
    return (typeof category == "string" && category.trim() != "") ? category : UNCATEGORIZED;
}

/**
 * Every category in use, sorted A-Z, with "Uncategorized" last if any picture has no label.
 */
export function tokenCategoryList(imgs)
{
    let categories = new Set();
    for(let name of Object.keys(imgs?.["tokens"] ?? {})){categories.add(tokenCategory(imgs, name));}

    let list = Array.from(categories).filter((c) => c != UNCATEGORIZED).sort((a, b) => a.localeCompare(b));
    if(categories.has(UNCATEGORIZED)){list.push(UNCATEGORIZED);}
    return list;
}

/**
 * Builds the category dropdown shown above a picture grid: "All" plus every category.
 * Choosing one hides the grid's pictures from other categories. Each picture in the grid
 * needs data-category set. Starts on `start` (a category) if given; call select.onchange()
 * once the pictures are in the grid to apply it.
 * Returns the <select>.
 */
export function makeCategoryFilter(imgs, grid, start)
{
    let select = document.createElement("select");
    select.classList = "categoryFilter";
    select.title = "Show one category";

    for(let category of [ALL_CATEGORIES, ...tokenCategoryList(imgs)])
    {
        let option = document.createElement("option");
        option.value = category;
        option.text = category;
        select.appendChild(option);
    }

    select.onchange = function ()
    {
        for(let item of grid.querySelectorAll("[data-category]"))
        {
            item.style.display = (select.value == ALL_CATEGORIES || item.dataset.category == select.value) ? "" : "none";
        }
    };

    select.onclick = (e) => e.stopPropagation(); //Don't let the click reach the grid underneath
    select.value = (start && Array.from(select.options).some((o) => o.value == start)) ? start : ALL_CATEGORIES;
    return select;
}

/**
 * A new, blank character record (playerChar/<name>) for a login joining a campaign.
 * `sampleStats` is any existing character's stats in the campaign: its keys are copied
 * blank so the character sheet has every field, with level-1 defaults filled in.
 * Placeholders keep favorites, skill tree and notes from being empty (Firebase drops
 * empty objects, and the pages expect them to exist).
 */
export function blankCharacter(name, sampleStats)
{
    let stats = {};
    for(let key of Object.keys(sampleStats ?? {})){stats[key] = "";}

    for(let ability of ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"])
    {
        stats[ability] = "+0";
        stats[`${ability}-ext`] = "10";
        stats[`${ability}Save`] = "+0";
    }

    Object.assign(stats, {"lv" : "1", "proficiency" : "+2", "AC" : "10", "Speed" : "30", "Initiative" : "+0",
        "InfusedRate" : "0", "totalHitDice" : "d8", "currentHitDice" : "1"});

    return {
        "charName" : name,
        "currentToken" : name,
        "discordName" : "",
        "infusedRate" : "0",
        "mode" : "waiting",
        "rage" : "false",
        "zoomLevel" : "100",
        "zoomSheetLevel" : "100",
        "stats" : stats,
        "skillTree" : {"start1" : "active"},
        "favorites" : {"actions" : {"hold" : {"hold" : "hold"}}, "spells" : {"hold" : {"hold" : "hold"}}},
        "notes" : {"Placeholder" : {"desc" : "Placeholder", "pos" : 0}}
    };
}

/**
 * Stats from any existing (non-DM) character in `chars`, to copy the sheet's fields from.
 */
export function sampleStats(chars)
{
    for(let name of Object.keys(chars ?? {}))
    {
        if(name != DM_LOGIN && chars[name]?.["stats"]){return chars[name]["stats"];}
    }
    return {};
}

/**
 * Shows the site's popup box on the top page (so a popup from a zoomed frame, like the
 * character sheet, is shown full size): a framed box over a dimmed page, buttons at the
 * bottom in the middle. Clicking the dim area or pressing Esc closes it.
 *   title, message (plain text), html (trusted markup from the site's own data),
 *   boxClass (extra class for the box, e.g. "popupTall"), buttons: [{label, value, primary}]
 * Resolves with the pressed button's value (null when closed another way).
 */
export function showPopup({title = "", message = "", html = "", boxClass = "", input = null, buttons = [{label: "Done", value: true, primary: true}]} = {})
{
    let doc = document;
    try{if(window.top.document.body){doc = window.top.document;}}catch(e){}

    return new Promise((resolve) =>
    {
        let el = (tag, cls, text) => {let e = doc.createElement(tag); if(cls){e.className = cls;} if(text != undefined){e.textContent = text;} return e;};
        let backdrop = el("div", "popupBackdrop");
        let box = el("div", ("popupBox " + boxClass).trim());
        box.setAttribute("role", "dialog");
        if(title){box.appendChild(el("h3", "popupTitle", title));}
        if(message){box.appendChild(el("p", "popupMessage", message));}
        if(html){let body = el("div", "popupBody"); body.innerHTML = html; box.appendChild(body);}

        //Optional text box: a primary button then resolves with its text
        let field = null;
        if(input)
        {
            field = el("input", "popupInput");
            field.type = "text";
            field.value = input.value ?? "";
            field.placeholder = input.placeholder ?? "";
            box.appendChild(field);
        }

        let close = (value) => {doc.removeEventListener("keydown", keys, true); backdrop.remove(); resolve(value);};
        let primaryValue = () => {let b = buttons.find((b) => b.primary); return field ? field.value : b?.value;};
        let keys = (e) =>
        {
            if(e.key == "Escape"){e.preventDefault(); e.stopPropagation(); close(null);}
            else if(e.key == "Enter" && field && doc.activeElement == field){e.preventDefault(); close(primaryValue());}
        };

        let row = el("div", "popupButtons");
        for(let b of buttons)
        {
            let button = el("button", "gridButton" + (b.primary ? " popupPrimary" : ""), b.label);
            button.onclick = () => close(field && b.primary ? field.value : b.value);
            row.appendChild(button);
        }
        box.appendChild(row);

        backdrop.onclick = (e) => {if(e.target == backdrop){close(null);}};
        backdrop.appendChild(box);
        doc.body.appendChild(backdrop);
        doc.addEventListener("keydown", keys, true);
        (field ?? row.querySelector(".popupPrimary"))?.focus();
        field?.select();
    });
}

/* ------------------------------------------------------------------------------------ *
 *  Spells missing from src/spells.json                                                  *
 *  The Cloudflare Worker looks a missing spell up on Open5e, converts it to this site's *
 *  format (with {@damage} / {@save} / {@scaledamage}) and keeps it, so the D&D and      *
 *  Sheets sites both have it from then on. The list it has kept is added on load.       *
 * ------------------------------------------------------------------------------------ */
export const SPELL_SERVICE = "https://statblock.vitheaxolotl.workers.dev";

/** Adds spells ({level: {Name: spell}}) that aren't in `target` yet (any capitalisation). */
export function mergeSpells(target, extra)
{
    for(let [level, list] of Object.entries(extra ?? {}))
    {
        for(let [name, spell] of Object.entries(list ?? {}))
        {
            if(!findSpellIn(target, name)){(target[level] ??= {})[name] = spell;}
        }
    }
    return target;
}

/** The spell with this name in a spell list (any level, any capitalisation): {level, key, spell} or null. */
export function findSpellIn(spells, name)
{
    let target = String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if(!target){return null;}

    for(let [level, list] of Object.entries(spells ?? {}))
    {
        for(let [key, spell] of Object.entries(list ?? {}))
        {
            if(key != "hold" && (key.toLowerCase() == target || String(spell?.["name"] ?? "").toLowerCase() == target)){return {level, key, spell};}
        }
    }
    return null;
}

/**
 * Finds a spell by name: in the site's list first, otherwise through the Worker (which adds
 * it for next time). Resolves {level, key, spell} or null if Open5e doesn't have it either.
 */
export async function findSpell(name, spells = window.top.parent.wholeSpells)
{
    let have = findSpellIn(spells, name);
    if(have){return have;}

    try
    {
        let response = await fetch(`${SPELL_SERVICE}/spell?name=${encodeURIComponent(String(name).trim())}`);
        if(!response.ok){return null;}
        let data = await response.json();
        if(!data?.spell){return null;}
        if(spells){(spells[data.level] ??= {})[data.spell.name] = data.spell;}
        return {level: data.level, key: data.spell.name, spell: data.spell};
    }
    catch(error)
    {
        console.error("Spell lookup failed:", error);
        return null;
    }
}

/** The spell card popup (the eye icons): the spell's details on parchment. */
export function showSpellCard(spell)
{
    let line = (label, value) => `<p class="card-text">${label}: ${value ?? ""}</p>`;
    return showPopup({boxClass: "popupSpell", html:
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

/** A spell neither list has: open it on Roll20 in a tall box. */
export function showSpellOnRoll20(name)
{
    let link = `https://roll20.net/compendium/dnd5e/${encodeURIComponent(name)}`;
    return showPopup({boxClass: "popupTall", title: name, html: `<iframe class="popupFrame" src="${link}" title="${name}"></iframe>`});
}

