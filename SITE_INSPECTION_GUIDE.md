# Site Inspection Guide

This guide walks you through inspecting the Orange County Comptroller's website
to find the CSS selectors the scraper needs. **You must do this before the
scraper will work.**

Don't worry — you don't need to understand code. You're just right-clicking on
things and copying text. I'll tell you exactly what to copy and where to paste it.

---

## What You'll Need

- Google Chrome browser (Safari won't work for this)
- About 20-30 minutes
- A text file to paste things into (Notes app or TextEdit is fine)

---

## What Are CSS Selectors?

Think of them like addresses for elements on a web page. Just like "123 Main St"
tells a delivery driver where to go, a CSS selector like `#searchButton` tells
the scraper which button to click. Every button, text field, and table on a website
has one.

---

## Let's Begin

### Step 1: Open Chrome Developer Tools

1. Open **Google Chrome**
2. Go to: `https://selfservice.or.occompt.com/ssweb/user/disclaimer`
3. Wait for the page to fully load
4. Right-click anywhere on the page
5. Click **"Inspect"** (it's at the bottom of the right-click menu)

A panel will open on the right side (or bottom) of your browser. This is
Chrome Developer Tools. It looks complex — ignore most of it. We only need
one feature.

### Step 2: Find the CAPTCHA Info

**Look at the page.** Is there a reCAPTCHA checkbox ("I'm not a robot")
or an invisible CAPTCHA?

**To find the site key:**

1. In the Developer Tools panel, press `Cmd + F` (this opens a search bar
   inside the panel)
2. Type: `data-sitekey`
3. If it highlights something, you'll see text like:
   `data-sitekey="6LcXxxxxxxxxxxxxxxxxxxxxx"`
4. **Copy that entire string of letters/numbers** between the quotes

**Write down:**
```
CAPTCHA type: [reCAPTCHA v2 / reCAPTCHA v3 / hCaptcha / None visible]
Site key: [paste the long string here]
```

### Step 3: Find the "I Accept" Button

1. On the page, find the "I Accept" or "Accept" button (the disclaimer button)
2. **Right-click directly on that button**
3. Click **"Inspect"** — the Developer Tools will jump to highlight that element
4. You'll see something like:
   ```html
   <button id="acceptButton" class="btn btn-primary">I Accept</button>
   ```
   or
   ```html
   <input type="button" value="I Accept" onclick="...">
   ```
   or
   ```html
   <a href="/ssweb/..." class="accept-link">I Accept</a>
   ```

5. **Right-click on the highlighted code** in Developer Tools
6. Hover over **"Copy"**
7. Click **"Copy selector"**

**Write down:**
```
Accept button selector: [paste what you copied]
```

Also write down what the HTML looks like (the tag name, any `id=` or `class=` you see).

### Step 4: Click Through to the Search Page

1. **Actually click the "I Accept" button** (solve the CAPTCHA manually if needed)
2. The next page should load
3. Look for a link or button that says something like:
   - "Official Records Search"
   - "Basic Official Records Search"
   - "Basic Search"

4. **Right-click on that link/button** → Inspect → right-click the highlighted code → Copy → Copy selector

**Write down:**
```
Search link selector: [paste what you copied]
```

### Step 5: Click Through to the Search Form

1. **Click that search link** to get to the actual search form
2. Now you should see a form with fields like:
   - Start Date
   - End Date
   - Document Type
   - A Search button

**For each of these, do the same thing:**
- Right-click on the field → Inspect → right-click the code → Copy → Copy selector

**Write down:**
```
Start date field selector:    [paste]
End date field selector:      [paste]
Document type field selector: [paste]
Search button selector:       [paste]
```

**Also note:**
- Does the date field open a calendar popup, or can you type directly?
- Is there a "Set Date" button you need to click?
- Is the document type field a dropdown, or do you type and it shows suggestions?

### Step 6: Do a Manual Search

1. Fill in today's date for both start and end date
2. For document type, type "Lis Pendens" and select it
3. Click the Search button
4. Wait for results to load

### Step 7: Inspect the Results Table

**If results appear:**

1. **Right-click on the results table** → Inspect → Copy → Copy selector

**Write down:**
```
Results table selector: [paste]
```

2. **Right-click on one DATA ROW** in the table (not the header) → Inspect → Copy → Copy selector

**Write down:**
```
Result row selector: [paste]
```

3. **Look at the table columns.** Write down what columns you see, in order.
For example:
```
Column 1: Document #
Column 2: Type
Column 3: Recording Date
Column 4: Grantee
Column 5: Legal Description
```

4. **Check for a "Next" button** at the bottom of the results. If one exists,
right-click → Inspect → Copy → Copy selector

**Write down:**
```
Next page button selector: [paste] (or "None" if no pagination)
```

### Step 8: Take Screenshots

For each page you visited, take a screenshot:

1. Press `Cmd + Shift + 3` to screenshot the whole screen
2. Or press `Cmd + Shift + 4` and drag to select an area

Save them — they'll be helpful for debugging later.

---

## What to Do With All This Info

Once you have all the selectors written down, you need to update the file
`src/config.ts`. Open it and find the `selectors` section (around line 60).

Replace each `[TODO]` placeholder with the real selector you found.

**Example — before:**
```typescript
acceptButton: '[TODO] #acceptButton, button containing "I Accept"',
```

**Example — after:**
```typescript
acceptButton: '#disclaimer-accept-btn',
```

**Or even better:** Just paste all your notes to me (your AI assistant) and
I'll update the file for you. That's the easiest approach.

---

## Quick Reference: How to Copy a Selector

For any element on the page:

1. Right-click the element on the page
2. Click "Inspect"
3. In the Developer Tools, right-click the highlighted line of code
4. Hover over "Copy"
5. Click "Copy selector"
6. Paste it into your notes

That's it. You'll do this ~10 times and you're done.

---

## Troubleshooting

### "I don't see an Inspect option"
Make sure you're using Chrome, not Safari. Safari's developer tools work
differently.

### "The Developer Tools panel is too small"
Grab the edge of the panel and drag it to make it wider. You can also click
the three dots (⋮) in the Developer Tools and change where the panel docks.

### "I can't find the element in the code"
Use the selector tool: click the icon in the top-left of Developer Tools that
looks like a cursor on a square (📱). Then click any element on the page and
it will highlight in the code.

### "The site looks different from what's described here"
Government websites change occasionally. Just describe what you see and
we'll adjust the scraper to match.
