/**
 * parent.js — the live data hub for the Dashboard (index.html).
 *
 * Loaded once by index.html. It opens a real-time listener on every part of the
 * Firebase database the dashboard needs and copies each one onto `window` (wholeDB,
 * wholeChar, wholeTO, ...). Every page shown inside a dashboard iframe (Sheet, Notes,
 * DM tools, Skill Tree...) reads its data from here through `window.top.parent`, so
 * those pages never open their own database connection.
 *
 * Whenever Firebase reports a change, the matching `window.whole*` object is replaced
 * and, where needed, handed to map.js / mapControler.js (setWholeDB, setWholeTO, ...)
 * so they can redraw.
 *
 * Firebase paths it watches:
 *   currentMap/        -> window.wholeDB        tokens on the battle map
 *   playerChar/        -> window.wholeChar      every character (stats, sheet, zoom levels, Vi's DM data)
 *   currentTO/         -> window.wholeTO        turn order
 *   playerChar/Vi/...  -> summons, interactive objects, quests, playerRefresh
 *   bubbles            -> window.wholeBubbles   spell-area circles drawn on the map
 *   rulers             -> window.wholeRulers    distance rulers being measured on the map
 *   display/           -> window.wholeDisplay   the 10 most recent combat messages
 *   files/, customImages/, preset/              shared images and preset tokens
 */

import { ref, onValue } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-database.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js'; 
import { auth, database, toTitleCase, setDoc, dbRef, character } from './js/viMethods.js';
import { setMode, setWholeDB, setWholeTO, setWholeSummons, setWholeBubbles, setWholeRulers } from './src/map.js';
import { setWholeInteractive, setWholeCharCont, setWholeQuests } from './js/mapControler.js';

// Global stores, filled in by the listeners below. Other pages read them via window.top.parent.
window.wholeCustom = {};
window.wholeBubbles = {};
window.wholeChar = {};
window.wholeDB = {};
window.wholeDisplay = {}; 
window.wholeInteractive = {};
window.wholePre = {};
window.wholeQuests = {};
window.wholeSummons = {};
window.wholeTO = {};
window.imgs = {};
window.wholeActions = {};
window.wholeSpells = {};
window.wholeRolls = {};

// Not logged in -> send them to the login page. Logged in -> remember the player's name
// (the part of their email before @, title-cased) and mark them as "waiting" in map.js.
onAuthStateChanged(auth, (user) => 
{
    if (!user) 
    {
        alert("You need to login before using this resource. Click Ok and be redirected, -map.html");
        window.location.href = "loginPage.html?map.html"; 
    } 

    else
    {
        window.player = character; //This login's character in the live campaign (see viMethods.js)
        setMode(auth);
    }
});

// Static rules data (actions, spells, preset rolls) loaded once from this site's src/ folder.
fetch('src/actions.json').then(res => res.json()).then((json) => wholeActions = json);
fetch('src/spells.json').then(res => res.json()).then((json) => wholeSpells = json);
fetch('src/rolls.json').then(res => res.json()).then((json) => wholeRolls = json);

// --- Real-time listeners: each one fires immediately with the current value, then on every change ---
const filesRef = dbRef('files/');
onValue(filesRef, (snapshot) => 
{
    const data = snapshot.val();
    imgs = data;
});

const customsRef = dbRef('customImages/');
onValue(customsRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeCustom = data;
});

// The campaign layer (viMethods.js) already knows this login's character, so set it
// before any data arrives; the map needs it to draw.
window.player = character;
let charsArrived = false; //The map waits for character data before its first draw

const currentMapRef = dbRef('currentMap/');
onValue(currentMapRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeDB = data;
    if(charsArrived){setWholeDB(data);}
});

const charRef = dbRef('playerChar/');
onValue(charRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeChar = data;
    // The DM (Vi) can ask everyone for a save/check; saveOrCheck holds which ability is being asked for.
    window.wholeRespone = data?.["Vi"]?.["responses"] ?? {};
    window.saveOrCheck = window.wholeRespone["ability"];
    setWholeCharCont(data);

    //First character data: now the map can be drawn (if the map data came first)
    if(!charsArrived){charsArrived = true; if(wholeDB){setWholeDB(wholeDB);}}
});

const currentTORef = dbRef('currentTO/');
onValue(currentTORef, (snapshot) => 
{
    const data = snapshot.val();
    wholeTO = data;
    setWholeTO(data);
});

const summonsRef = dbRef('playerChar/Vi/summons');
onValue(summonsRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeSummons = data;
    setWholeSummons(data);
});

const bubbleRef = dbRef('bubbles');
onValue(bubbleRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeBubbles = data;
    setWholeBubbles(data);
});

//Distance rulers (right-click measuring on the map), one per player
const rulerRef = dbRef('rulers');
onValue(rulerRef, (snapshot) => 
{
    setWholeRulers(snapshot.val());
});

const interactiveRef = dbRef('playerChar/Vi/interactive');
onValue(interactiveRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeInteractive = data;
    setWholeInteractive(data);
});

const displayRef = dbRef('display/');
onValue(displayRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeDisplay = data;
});

const questRef = dbRef(`playerChar/Vi/quests/`);
onValue(questRef, (snapshot) =>
{
    const data = snapshot.val();
    wholeQuests = data;
    setWholeQuests(data);
});

const presetRef = dbRef('preset/');
onValue(presetRef, (snapshot) => 
{
    const data = snapshot.val();
    wholePre = data;
});

// The DM tools can force one player's page to reload by writing their name here.
const refreshRef = dbRef(`playerChar/Vi/playerRefresh`);
onValue(refreshRef, (snapshot) =>
{
    const data = snapshot.val();

    if(data == null){return;}

    //"Refresh all players": {target: "All", at: <time>}. Nobody can clear it for everyone,
    //so each page remembers the last one it handled and reloads once. Old requests
    //(over 5 minutes) are ignored, and the DM's own page isn't reloaded.
    if(typeof data == "object" && data.target == "All")
    {
        if(window.player == "Vi"){return;}

        let handled = null;
        try{handled = localStorage.getItem("lastRefreshAll");}catch(e){}

        if(handled != String(data.at) && Math.abs(Date.now() - data.at) < 5 * 60 * 1000)
        {
            try{localStorage.setItem("lastRefreshAll", String(data.at));}catch(e){}
            location.reload(true);
        }

        return;
    }
    
    if(window.player == data)
    {
        setDoc(`playerChar/Vi/playerRefresh`, null);
        location.reload(true); 
    }
});
