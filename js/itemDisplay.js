/**
 * itemDisplay.js — the Item Lookup tab (itemIndex.html, shown in an iframe).
 *
 * Looks up an item by its exact name in the shared images data (files/items in Firebase,
 * loaded by parent.js as window.imgs) and shows its description and picture.
 */

"use strict";
import { reload } from '../js/viMethods.js';

/**
 * Hooks up the Search and Reset buttons.
 */
function init()
{ 
    document.getElementById("searchItem").onclick = handleSearch;

    //Shows the item as soon as the typed code matches one (Enter or Search also work)
    let txtBox = document.getElementById("searchTxt");
    txtBox.oninput = () => {if(findItem(txtBox.value)){handleSearch();}};
    txtBox.onkeydown = (e) => {if(e.key == "Enter"){handleSearch();}};
    document.getElementById("resetItem").onclick = handleReset;
}

/**
 * Finds the typed item name in window.top.parent.imgs.items, shows its description
 * and image, and scrolls down to them.
 */
function handleSearch()
{
    let txtBox = document.getElementById("searchTxt");
    let display = document.getElementById("description");
    let image = document.getElementById("itemImg");
    let item = findItem(txtBox.value);

    if(!item)
    {
        display.innerHTML = "<b>No item has that code. Check the spelling and try again.</b>";
        image.classList = "invisible";
        return;
    }

    if(display.dataset.shown == item.key){return;} //Already showing (typing more letters, etc.)
    display.dataset.shown = item.key;

    display.innerHTML = item["desc"]; //Changes display to show the item's descriptions
    image.classList = ""; //Makes the image visible
    image.src = item["img"]; //Adds the image of the item
    display.scrollIntoView({behavior: 'smooth'}); //Moves the view to the item's description
}

/**
 * The item whose code is `code` (spaces around it ignored), or null.
 */
function findItem(code)
{
    let items = window.top.parent.imgs?.["items"] ?? {};
    let key = String(code ?? "").trim();
    return items[key] ? {...items[key], key} : null;
}

/**
 * Clears the lookup by reloading the page.
 */
function handleReset()
{
    reload(.1)
}

init();
