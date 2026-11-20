/**
 * selection.js — the Change Token page (selection.html).
 *
 * Where a player sets up the token that represents them on the battle map:
 *   1. pick a picture (their standard token from files/tokens, or a custom image they uploaded),
 *   2. pick a coloured border ring,
 *   3. enter Max / Current / Temp HP and AC,
 *   4. Go! saves the token to the map (currentMap/<Name>) and to their character
 *      (playerChar/<Player>/token), then sends them to the dashboard.
 * If they already had a token, its border, HP, title and map position are kept.
 *
 * Custom images: "Manage Imgs" lets a player upload their own picture (file picker + Upload).
 * It's compressed in the browser, stored in Firebase Storage under images/map/tokens/, and
 * listed in files/tokens/<name>- in the Characters category. Token names end in "-".
 */

"use strict";
import { ref, onValue } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-database.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js';
import { toTitleCase, auth, database, setDoc, clenseInput, deleteDoc, reload, placeBefore, tokenCategory, CHARACTER_CATEGORY, dbRef, character, login, campaign, holdCampaignReload, blankCharacter, sampleStats, titleWithName, isValidKey, DM_LOGIN, storage } from './viMethods.js';
import { uploadBytes, getDownloadURL, ref as sRef } from 'https://www.gstatic.com/firebasejs/9.15.0/firebase-storage.js';
import imageCompression from 'https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.mjs';

let player;
let wholeChars = {};
let wholeCustom = {};
let wholeDb = {};
let enter = document.getElementById("enter");
let charName = document.getElementById("name");
let div = document.getElementById("story");
let borders = [];
let char = document.createElement("h3");
let bord = document.createElement("h3");
let hp = document.createElement("h3");
let go = document.createElement("button");
let people = [];
let firstRun = true;
let firstRunCustom = true;
let imgs = {};
let oldToken = {};
let isNewCharacter = false; //This login has no character in the live campaign yet

// This page sets the login's character itself, so it mustn't reload when that happens.
holdCampaignReload();

// Only the first read of character data is used to build the page, and only once the
// picture lists (files/) have arrived too: the page needs both, in whichever order they come.
let charsLoaded = false;
let filesLoaded = false;

function buildWhenReady()
{
    if(firstRun && charsLoaded && filesLoaded)
    {
        firstRun = false;
        userLoggedIn();
    }
}

const charRef = dbRef('playerChar/');
onValue(charRef, (snapshot) => 
{
    if(!charsLoaded){wholeChars = snapshot.val() ?? {};}
    charsLoaded = true;
    buildWhenReady();
});

const customsRef = dbRef('customImages/');

const mapRef = dbRef('currentMap/');
onValue(mapRef, (snapshot) => 
{
    const data = snapshot.val();
    wholeDb = data;
});

// The list of border images lives in files/borders. Once it arrives, build the page.
const filesRef = dbRef('files/');
onValue(filesRef, (snapshot) => 
{
    const data = snapshot.val();
    imgs = data ?? {};
    filesLoaded = true;
    buildWhenReady();
});

onAuthStateChanged(auth, (user) => 
{
    if (!user) 
    {
        alert("You need to login before using this resource. Click Ok and be redirected");
        window.location.href = "loginPage.html?selection.html"; 
    } 
});

/**
 * Runs once character data arrives: works out who is logged in, remembers their
 * current token (oldToken) so its settings can be kept, and builds the headings.
 */
function userLoggedIn()
{
    //This login's character in the live campaign; a login with none yet makes one named after them
    player = character ?? login;
    isNewCharacter = !wholeChars?.[player];
    oldToken = wholeChars?.[player]?.["token"] ?? null;
    init();
    charName.value = wholeChars?.[player]?.["charName"] ?? player;
    setUpCharacters();

    if(isNewCharacter) //Tell them why they're here
    {
        let note = document.createElement("h5");
        note.innerHTML = `You don't have a character in this campaign yet. Pick a picture and border, then press Go! to make one.`;
        div.prepend(note);
    }
}

/**
 * Creates the section headings (Select Character, Select Border, Current & Max Hp)
 * and the Go! button, ready to be placed by setUpCharacters().
 */
function init()
{
    char.innerHTML = "Select Character";
    char.classList = "blo";
    char.style.margin = "5px";
    bord.innerHTML = "Select Boarder";
    bord.classList = "blo";
    bord.style.margin = "5px";
    go.innerHTML = "Go!";
    go.classList = "blo";
    go.style.margin = "5px";
    hp.innerHTML = "Current & Max Hp";
    hp.classList = "blo";
    hp.style.margin = "5px";

    enter.onclick = setUpCharacters;
    go.onclick = handleGoButton;
    
    let temp = imgs["borders"];
    for(let border of Object.keys(temp)){if(border != "invisible"){borders.push(border);}} //Populates the borders with each border
}

/**
 * Builds the page: hides the placeholder content, then adds the player's token pictures,
 * the border rings, the HP/AC boxes and Go!. If they already have a token, it
 * pre-selects their border and fills in their HP.
 */
function setUpCharacters()
{
    for(let elem of div.children)
    {
        elem.classList = "hide";
    }

    people.push(player+"-");
    div.appendChild(char);

    addCharacters()
    addBorders();
    addHp();
    div.appendChild(go);

    onValue(customsRef, (snapshot) => 
    {
        const data = snapshot.val();
        wholeCustom = data;
        
        if(firstRunCustom)
        {
            addCustomImgs();
            firstRunCustom = false;
        }
    });

    if(oldToken != null || oldToken != undefined)
    {
        document.getElementById(`${oldToken["border"]}`).onclick();
        document.getElementById(`Max Hp`).value = oldToken["maxHp"];
        document.getElementById(`Current Hp`).value = oldToken["currentHp"];
        document.getElementById(`Temp Hp`).value = oldToken["tempHp"];
    }
}

/**
 * Opens the link stored in the clicked element's id in a new tab, then reloads. Not used now.
 */
function openWindow()
{    
    setInterval(() => {window.open(this.id, '_blank'); location.reload();}, 2000);   
}

/**
 * Adds a clickable picture for each standard token this player can use: their own
 * picture (<Name>-) first, then every picture in the "Characters" category.
 */
function addCharacters()
{
    let characters = Object.keys(imgs["tokens"] ?? {})
        .filter((name) => tokenCategory(imgs, name) == CHARACTER_CATEGORY && !people.includes(name))
        .sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: "base"}));
    people.push(...characters);

    for(let char of people)
    {
        if(!imgs["tokens"]?.[char]){continue;} //No picture uploaded under this name
        let person = document.createElement("img");
        person.id = char;
        person.src = imgs["tokens"][char];
        person.classList = "char";
        person.onclick = handleChoose;
        div.appendChild(person);
    }
}

/**
 * Adds the player's own uploaded images as more token choices, plus the
 * "Manage/Add Imgs" button. Pre-selects their current token picture.
 */
function addCustomImgs()
{
    for(let custom of Object.keys(wholeCustom))
    {
        if(wholeCustom[custom]["player"] == player)
        {
            let person = document.createElement("img");
            person.id = wholeCustom[custom]["name"];
            person.src = wholeCustom[custom]["src"];
            person.classList = "char customImg";
            person.style.width = "73px";
            person.style.height = "73px";
            person.onclick = handleChoose;
            placeBefore(person, bord);
        }
    }

    let customsBtn = document.createElement("button");
    customsBtn.classList = "gridButton";
    customsBtn.innerHTML = "Manage Imgs";
    customsBtn.style.width = "100%";
    customsBtn.onclick = handleCustomImg;
    placeBefore(customsBtn, bord);

    
    if(oldToken != null || oldToken != undefined)
    {
        document.getElementById(`${oldToken["name"]}`).onclick();
    }
}

/**
 * "Manage Imgs": replaces the page with an upload form: file picker, a name for the
 * picture (filled in from the file name, editable), Cancel and Upload. The picture is
 * listed under that name plus "-" (Tiger -> "Tiger-").
 */
function handleCustomImg()
{
    while(div.children.length > 0)
    {
        div.lastChild.remove();
    }

    let form = document.createElement("div");
    form.classList.add("center", "uploadToken");

    let fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.id = "CustomFileInput";

    //The picture's name; filled in from the file name when one is picked, and editable
    let nameInput = document.createElement("input");
    nameInput.id = "CustomName";
    nameInput.placeholder = "Picture name (e.g. Tiger)";
    fileInput.onchange = () => {if(fileInput.files?.[0]){nameInput.value = tokenNameFromFile(fileInput.files[0].name).slice(0, -1);}};

    let buttons = document.createElement("div");
    buttons.classList.add("uploadTokenButtons");

    let uploadBtn = document.createElement("button");
    uploadBtn.classList = "gridButton";
    uploadBtn.innerHTML = "Upload";
    uploadBtn.onclick = handleCreateCustom;

    let cancelBtn = document.createElement("button");
    cancelBtn.classList = "gridButton";
    cancelBtn.innerHTML = "Cancel";
    cancelBtn.onclick = () => reload(.001); //Back to the character list

    let status = document.createElement("p");
    status.id = "uploadStatus";
    status.classList.add("campaignStatus");

    buttons.appendChild(cancelBtn);
    buttons.appendChild(uploadBtn);
    form.appendChild(fileInput);
    form.appendChild(nameInput);
    form.appendChild(buttons);
    form.appendChild(status);
    div.appendChild(form);
}

/**
 * Deletes one custom image. Any token on the map still using it falls back to that
 * character's standard picture ("<id>-").
 */
function handleDeleteCustom()
{
    deleteDoc(`customImages/${this.id}`);
    
    for(let tokens of Object.keys(wholeDb))
    {
        if(wholeDb[tokens]["name"] == this.id)
        {
            let access = wholeDb[tokens]["id"];
            let newToken = wholeDb[access];

            newToken.name = `${newToken.id}-`;
            setDoc(`currentMap/${access}`, newToken);
        }
    }   

    reload(.5);
}

/**
 * A picture's name from a file name: "Big Tiger.png" -> "BigTiger-". Only letters,
 * numbers, _ and - are kept (the database can't store . # $ [ ] / in a name).
 */
function tokenNameFromFile(fileName)
{
    let base = String(fileName ?? "").replace(/\.[^.]*$/, "");
    base = base.replace(/[^A-Za-z0-9_-]/g, "").replace(/-+$/, "");
    return base == "" ? "" : base + "-";
}

/**
 * Upload: compresses the picked picture (about 0.2 MB, 1024px), stores it in Firebase
 * Storage under images/map/tokens/<name>-, lists it in files/tokens/<name>- in the
 * Characters category, then reloads so it can be picked. A name that's already taken
 * is refused, so nobody's picture gets replaced.
 */
async function handleCreateCustom()
{
    let fileInput = document.getElementById("CustomFileInput");
    let status = document.getElementById("uploadStatus");
    let uploadBtn = this;
    let say = (text, isError) => {status.textContent = text; status.classList.toggle("error", !!isError);};

    let file = fileInput.files?.[0];
    if(!file){say("Pick a picture first.", true); return;}

    let typed = document.getElementById("CustomName").value;
    if(typed.trim() == ""){say("Give the picture a name.", true); return;}
    let name = tokenNameFromFile(typed + ".x"); //Same clean-up as a file name
    if(name == ""){say("Use letters or numbers in the name.", true); return;}
    if(imgs["tokens"]?.[name]){say(`There's already a picture called ${name.slice(0, -1)}. Pick another name.`, true); return;}

    uploadBtn.disabled = true;
    say("Uploading...");

    try
    {
        const compressed = await imageCompression(file, {maxSizeMB: 0.2, maxWidthOrHeight: 1024, useWebWorker: true});
        const snapshot = await uploadBytes(sRef(storage, `images/map/tokens/${name}`), compressed);
        const url = await getDownloadURL(snapshot.ref);

        await setDoc(`files/tokens/${name}`, url);
        await setDoc(`files/tokenCategories/${name}`, CHARACTER_CATEGORY); //Player uploads are characters

        say(`Uploaded ${name.slice(0, -1)}. Reloading...`);
        reload(.5);
    }

    catch(error)
    {
        console.error("Token upload failed:", error);
        say("The upload didn't work. Try again, or try a smaller picture.", true);
        uploadBtn.disabled = false;
    }
}

/**
 * Adds a clickable ring picture for every border colour (except "invisible").
 */
function addBorders()
{
    for(let i = 0; i < borders.length; i++)
    {
        let color = borders[i];
        borders[i] = document.createElement("img");
        borders[i].src = imgs["borders"][color]; //Border pictures live in Firebase Storage (files/borders)
        borders[i].id = color;
        borders[i].classList = "bord";
        borders[i].onclick = handleChoose;
    }

    div.appendChild(bord);
    for(let border of borders)
    {
        div.appendChild(border);
    }
}

/**
 * Adds the Max Hp / Current Hp / Temp Hp / AC number boxes.
 */
function addHp()
{
    div.appendChild(hp);
    let names = ["Max Hp", "Current Hp", "Temp Hp", "AC"];
    let labels = [document.createElement("h6"), document.createElement("h6"), document.createElement("h6"), document.createElement("h6")];
    let numbers = [document.createElement("input"), document.createElement("input"), document.createElement("input"), document.createElement("input")];

    for(let i = 0; i < names.length; i++)
    {
        let seprateDiv = document.createElement("div");
        labels[i].innerHTML = names[i] + ':';
        labels[i].classList = "labelS";
        seprateDiv.appendChild(labels[i]);

        numbers[i].id = names[i];
        numbers[i].type = "number";
        numbers[i].min = "0";
        numbers[i].step = "1";
        numbers[i].style.width = "10%";
        numbers[i].classList = "numberInput";
        seprateDiv.appendChild(numbers[i])

        div.appendChild(seprateDiv);
    }
}

/**
 * A picture or border was clicked: un-highlight the others in the same group and
 * highlight this one ("selected").
 */
function handleChoose()
{
    let classL = this.classList.value;
    let elementsToClear;

    if(classL.includes("char")){elementsToClear = document.getElementsByClassName("char");}
    else if(classL.includes("bord")){elementsToClear = document.getElementsByClassName("bord");}

    for(let element of elementsToClear)
    {
        element.classList.remove("selected");;
    }

    this.classList.add("selected");
}

/**
 * Go!: needs one picture and one border selected. Saves the token, swaps the page for a
 * loading message, then goes to the dashboard after 2 seconds.
 */
function handleGoButton()
{
    let currentSelected = document.getElementsByClassName("selected");
    if(currentSelected.length == 2)
    {
        let curBorder = currentSelected[1].id;
        let curCharacter = currentSelected[0].id;
        createChar(curCharacter, curBorder);

        let loop = true;
        while(loop)
        {
            try 
            {
                if(div.children.length > 0)
                {
                    div.removeChild(div.children[1]);
                }

                else
                {
                    loop = false;
                    break;
                }
            } 
            
            catch (error) 
            {
                loop = false;
                break;
            }
        }

        //Loading screen: a spinning brass d20 and a bar that fills while the token saves
        let loading = document.createElement("div");
        loading.className = "tokenLoading";
        loading.innerHTML = `
            <svg class="tokenLoadingDie" viewBox="0 0 100 100" aria-hidden="true">
                <circle class="tokenLoadingRing" cx="50" cy="50" r="47"></circle>
                <polygon points="50,8 86,29 86,71 50,92 14,71 14,29"></polygon>
                <polygon points="50,29 70,64 30,64"></polygon>
                <polyline points="50,8 50,29 14,29 30,64 14,71 50,92 70,64 86,71 70,64 86,29 50,29"></polyline>
                <polyline points="30,64 50,92"></polyline>
                <text x="50" y="57">20</text>
            </svg>
            <h3>Readying your token<span class="tokenLoadingDots"><span>.</span><span>.</span><span>.</span></span></h3>
            <div class="tokenLoadingBar"><div></div></div>`;
        div.classList.add("center"); 
        div.appendChild(loading);
        setTimeout(() => {window.location.href = `index.html`;}, 2000); //The dashboard (there's no map.html)
    }
}

/**
 * Builds the token object and saves it to the map and to the player's character.
 * The map id is the picture name without its trailing "-". A new token starts at A1
 * with the name as its title; an existing token keeps its title, position and summon flag.
 */
function createChar(curCharacter, curBorder)
{
    //The token's id is the character's key (Mistah), whatever picture they pick, so picking
    //a new picture updates their token instead of adding another. (The DM keeps theirs.)
    let tokenId = (player == DM_LOGIN && oldToken?.["id"]) ? oldToken["id"] : player;
    let char = {border : curBorder, currentHp : `${document.getElementById("Current Hp").value}`, maxHp : `${document.getElementById("Max Hp").value}`, tempHp : document.getElementById("Temp Hp").value, map : "", id : tokenId, name : curCharacter, title : titleWithName("", player), xPos : "1", yPos : "A", isSummon : false, AC : document.getElementById("AC").value || "10"}; //Blank AC box -> 10

    if(oldToken != null || oldToken != undefined)
    {
        //Keep where they are and their status words; the title must still name them
        let onMap = wholeDb?.[oldToken["id"]];
        char["title"] = player == DM_LOGIN ? oldToken["title"] : titleWithName(onMap?.["title"] ?? oldToken["title"], player);
        char["xPos"] = onMap?.["xPos"] ?? oldToken["xPos"];
        char["yPos"] = onMap?.["yPos"] ?? oldToken["yPos"];
        char["isSummon"] = oldToken["isSummon"] ?? false;

        //Their old token had another id (e.g. named after an old picture): take it off the
        //map, unless another character's token uses that id too
        let oldId = oldToken["id"];
        let sharedId = Object.keys(wholeChars ?? {}).some((key) => key != player && wholeChars[key]?.["token"]?.["id"] == oldId);
        if(oldId && oldId != tokenId && isValidKey(oldId) && !sharedId && !["map", "spawnPoint"].includes(oldId))
        {
            deleteDoc(`currentMap/${oldId}`);
        }
    }

    if(isNewCharacter)
    {
        //A blank character first (sheet fields copied from another character in this campaign)
        setDoc(`playerChar/${player}`, blankCharacter(player, sampleStats(wholeChars)));
    }

    setDoc(`currentMap/${tokenId}`, char);
    setDoc(`playerChar/${player}/token`, char);
    setDoc(`playerChar/${player}/currentToken`, tokenId);

    //Link this login to the character in the live campaign (last, once the character exists)
    if(isNewCharacter){setDoc(`campaigns/${campaign}/players/${login}`, player);}
}
