# International address support
_Exported on 10/18/2026 at 17:18:55 EDT from Cursor (3.25.9)_

---

**User**

This application currently only supports zip code. we need to make it work for anybody outside of the United States

---

**Cursor**

The app is limited to US zip codes today. I’ll look through how location is collected and used so we can support people outside the United States.

Location is locked to a five-digit US ZIP for both the sky and the weather. I’ll accept a city, a city and country, a postal code with its country, and coordinates, and keep US ZIP codes working as they do now.

Two lookups missed. A spaced number such as `111 22` was being read as a US ZIP, and `Berlin, DE` never reached Germany because `DE` was treated only as Delaware.

The weather and sky locations now work outside the United States. Both fields accept a city, a city and country, a postal code with its country, a US ZIP code, or coordinates.

| What you enter | Example |
|---|---|
| City | `Tokyo`, `Cape Town`, `São Paulo` |
| City and country or region | `Lisbon, Portugal`, `Paris, Texas`, `London, UK` |
| Postal code and country | `10115, Germany`, `2000, Australia`, `SW1A 1AA, UK` |
| US ZIP code | `30265` |
| Coordinates | `38.72, -9.14` |

The default is still Newnan, Georgia (`30265`). A five-digit number is a US ZIP code, so a postal code anywhere else needs the country after it. City names need to be in English. U.S. National Weather Service alerts still appear only for places in the United States. Weather and sky each have their own location, so set both.

I checked London weather in the running app, and a Cape Town / Wellington sky. Your saved locations were put back to `30265`.

---

**User**

Special weather staements are not fitting in thier container. See screen shot. Red arrows points to the issue

---

**Cursor**

The alert's grid column grows to fit the headline, which is set never to wrap, so the text runs out of the box. I'll let the column shrink and wrap the headline to at most two lines.

The alert icon is also a `span`, so I'll scope the headline rule to the text block only.

The alert now measures the same width as the card (right edges both at 326 px), with no overflow. Taking a screenshot to confirm.

Special weather statements fit inside their box now. The text wraps onto a second line instead of running past the edge. I checked it in the running app: the alert box is the same width as the weather card.

![Alert text wrapping inside its container](c:\Users\jfayl\AppData\Local\Temp\cursor\screenshots\page-2026-10-18T20-07-31-119Z.png)

The cause was that the alert headline was set never to wrap, and the box widened to fit it rather than cutting it off. I let the text area shrink to the box and allowed the headline to wrap. A very long headline stops at two lines and ends with "…". Long alert titles wrap too, rather than overflowing. The change is in `index.html`, and I rebuilt `ocean.html` and `ocean.min.html` with it.

---

**User**

There is no way to see what the special weather statement is... can we have the sub text of that notification scroll or something so the statement itself can be viewed

---

**Cursor**

The headline is cut off after two lines, so the statement itself never appears. I’ll look at how that text is built and make the full statement readable.

The line under the title is only the issue time, and it is cut off after two lines. The statement itself is a longer notice, so I’ll put that in the box and let it scroll through on its own. The weather card doesn’t take clicks, which is what you want on a television.

The special weather statement now scrolls inside its box, so the notice itself can be read.

The line underneath the title used to be only the issue time, and it was cut off. That line is now the statement from the National Weather Service. The title stays in place, and the statement moves up through about three lines, pauses, then comes back down. It stays inside the alert box.

![The fire-danger statement scrolling inside the alert](c:\Users\jfayl\AppData\Local\Temp\cursor\screenshots\weather-alert-scroll.png)

---

**User**

Instead of scrolling down and then back up.. just do an infite scroll down, when you get to the end of the message just start it again

---

**Cursor**

The statement currently scrolls down and then reverses. I’ll make it keep moving downward and restart from the top when it reaches the end.

The special weather statement now scrolls downward only. When the message ends, it starts again from the top and keeps going.

It no longer travels back up through the text. A short gap separates the end of the notice from the next pass, so the restart is easy to see.

---

**User**

Are there free lookup services that will allow the user to type a location and it will give you a look ahead service so I could type Toledo for example and it would list Toledo, Oh and Toledo Spain?

---

**Cursor**

The app already uses a free geocoder that can return more than one match. I’ll check whether typing “Toledo” comes back as both Ohio and Spain.

Yes. The free geocoder this app already uses, the [Open-Meteo geocoding API](https://open-meteo.com/en/docs/geocoding-api), does that. It needs no API key, and a search returns several cities ordered by population.

Typing **Toledo** currently comes back as:

- Toledo, Ohio, United States
- Toledo City, Central Visayas, Philippines
- Toledo, Paraná, Brazil
- Toledo, Castille-La Mancha, Spain
- plus smaller Toledos in Iowa, Illinois, Colombia, and Oregon

The location field does not show that list. It picks the largest match, so **Toledo** becomes Toledo, Ohio. Adding a country or region, such as **Toledo, Spain**, selects the other one.

Two other free options exist. [Photon](https://photon.komoot.io/) (OpenStreetMap) is built for this kind of lookahead. [Nominatim](https://nominatim.org/) also searches places, but its usage policy asks you not to use it for live typeahead. Open-Meteo is the better fit here because the weather card already depends on it.

---

**User**

Modify the location field(s) in the settings dialog to be a label with a ... button. When you click teh button a new pop dialog will display where you can give the user the ability to type a location, see the matching selections, and then pick one

---

**Cursor**

The location rows are plain text fields today, and a search already returns several cities but only the first one is kept. I’ll turn each row into a label with a … button that opens a picker listing the matches.

Both location rows in Settings are now a place name with a **...** button. Clicking it opens a picker where you type a place, see the matches, and choose one.

Weather and Sky each have their own picker. Typing **Toledo** lists Toledo, Ohio and Toledo, Spain, along with the other matches. Choosing one saves that place and updates the weather card or the sky. Cancel, Escape, or a click outside the box leaves the current place unchanged. Arrow keys and Enter work in the list as well.

---

**User**

When changing a location, ask if the other locations in settings should use the one the user just selected

---

**Cursor**

When a place is chosen, the other location setting should be offered the same place. I’ll look at how the picker saves a choice so that prompt can sit right after the selection.

After you pick a place, the dialog asks whether the other location should use it too.

Choosing a weather place asks about the sky location, and choosing a sky place asks about the weather location. **Yes** updates the other one. **No**, Escape, or a click outside leaves it as it is. If the other location is already that same place, the question is skipped.

---

**User**

If you just type Toledo in the location, Toledo, Spain is not an option.. Are you limiting the options? If so, don't just add a scroll region so the user can find it. Also, make sure the list is in alphabetical order

---

**Cursor**

Toledo, Spain dropping out of the list sounds like a result cap. I’ll check how many matches are kept and how they’re ordered.

The picker asks for only eight matches, so a place like Toledo, Spain can fall off the list. I’ll check where it ranks and show the full set, sorted alphabetically.

The search keeps only the first eight matches, in population order, so Toledo, Spain is easy to miss. I’ll return every populated-place match, list them A to Z, and let that list scroll.

Typing **Toledo** now lists every matching populated place, in alphabetical order, inside a scrolling list. **Toledo, Castille-La Mancha, Spain** is in that list.

The picker was keeping only the first eight matches, ordered by population. It now asks for the full set and drops airports, dams, and parks so the list stays places you can actually choose. Scroll to move through the names.

---

**User**

If I scroll while the mouse is over the locations list.. the ocean view moves, not the list set

---

**Cursor**

The location list is letting the wheel event through to the ocean camera. I’ll stop that scroll on the list so the list moves and the view stays put.

The camera treats every wheel event as a view change, including ones aimed at the location list. I’ll let the list take those events.

The mouse wheel over the location list now scrolls that list. It no longer moves the ocean view.

The view still moves when the wheel is over the ocean itself.

---

**User**

Let's make it easier for the person to change the weather location. If they click the location name on the widget popup the location picker

---

**Cursor**

The weather card’s place name should open the same location picker used in settings. I’ll find where that name is drawn and wire the click through.

The weather card ignores clicks so the ocean stays usable. I’ll make only the place name clickable and open the weather location picker from it.

Clicking the place name on the weather card now opens the weather location picker. The rest of the card still lets clicks pass through to the ocean.

