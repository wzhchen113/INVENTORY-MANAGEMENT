"""
Scrape modifiers for each menu item on DoorDash by clicking into each item modal.
Uses Playwright headless browser.
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

DOORDASH_URL = "https://www.doordash.com/en/store/2am-project-28984787/"
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "modifiers_data.json")

ITEMS_TO_CHECK = [
    "Philly Cheesesteak", "Wings", "2AM Cheeseburger", "Combo Over Rice",
    "Triple Mix", "Chicken Quesadilla", "Crabmeat Fries", "Mozzarella Sticks",
    "Half N Half Tea", "Chicken Over Rice", "French Fries",
    "Shrimp Over Rice", "Steak Over Rice", "Lamb Over Rice",
    "Cheesesteak Quesadilla", "Mac N' Cheese Bites", "Mac N Cheese",
    "2AM Nuggets", "Hush Puppies", "Onion Rings", "Sweet Potato Fries",
    "2AM Hashbrown", "Cajun Fries",
    "Shrimp Po Boy", "Chicken Cheesesteak", "Fried Fish Sandwich",
    "Spicy Chicken Sandwich", "Chicken Sandwich",
    "Shrimp Gyro", "Combo Gyro", "Steak Gyro", "Lamb Gyro", "Chicken Gyro",
    "Surf & Turf", "Bird & Buried", "Fish & Chips",
    "Thai Iced Tea", "Can Soda", "Bottled Water",
    "Tres Leches", "Banana Pudding", "Caramel Mousse", "Carrot Cake",
    "Chocolate Lava Cake", "Chocolate Mousse", "Cheesecake Slice", "Choco Cake Slice",
    "Seafood Boil Sauce", "Build-A-Catch",
]


async def extract_modal_modifiers(page):
    """Extract modifier groups and options from an open modal dialog."""
    return await page.evaluate(r"""
        () => {
            const modal = document.querySelector('[role="dialog"]');
            if (!modal) return null;

            const text = modal.textContent || "";
            // Parse modifier groups using regex-like approach
            // Groups typically appear as: "Group Name" + "Required/Optional" + options
            const groups = [];

            // Find all elements that look like group headers
            const allEls = modal.querySelectorAll('*');
            let currentGroup = null;
            let currentOptions = [];

            for (const el of allEls) {
                const t = el.textContent.trim();
                const directText = Array.from(el.childNodes)
                    .filter(n => n.nodeType === 3)
                    .map(n => n.textContent.trim())
                    .join('');

                // Check if this looks like a group header
                // Group headers contain "Required" or "Optional" or "Select" or "Choose"
                if (directText && (
                    directText.includes('Required') ||
                    directText.includes('Optional') ||
                    directText.includes('Select') ||
                    directText.includes('Choose')
                )) {
                    continue; // skip requirement labels
                }
            }

            // Better approach: get the full text and parse it
            const fullText = modal.innerText || modal.textContent;
            return fullText;
        }
    """)


async def click_item_and_get_modifiers(page, item_name):
    """Click a menu item and extract its modifiers from the modal."""
    # Scroll to find the item
    found = False
    scroll_pos = 0
    max_scroll = await page.evaluate("document.body.scrollHeight")

    while scroll_pos < max_scroll and not found:
        await page.evaluate(f"window.scrollTo(0, {scroll_pos})")
        await page.wait_for_timeout(400)

        # Try to find and click the item
        buttons = await page.query_selector_all('div[role="button"]')
        for btn in buttons:
            label = await btn.get_attribute("aria-label")
            if label and label.strip() == item_name:
                await btn.click()
                found = True
                break
            # Also check text content for partial matches
            text = await btn.inner_text()
            if text and text.startswith(item_name + "\n"):
                await btn.click()
                found = True
                break
            if text and text.startswith(item_name + "$"):
                await btn.click()
                found = True
                break

        scroll_pos += 500

    if not found:
        return None

    # Wait for modal
    await page.wait_for_timeout(1500)

    # Extract modal text
    modal_text = await page.evaluate("""
        () => {
            const modal = document.querySelector('[role="dialog"]');
            return modal ? modal.innerText : null;
        }
    """)

    # Close modal
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(500)

    # Also try close button
    try:
        close_btn = page.locator('button[aria-label="Close"]').first
        if await close_btn.is_visible(timeout=500):
            await close_btn.click()
    except:
        pass

    await page.wait_for_timeout(300)
    return modal_text


def parse_modifiers(raw_text):
    """Parse raw modal text into structured modifier groups."""
    if not raw_text:
        return []

    lines = raw_text.split("\n")
    groups = []
    current_group = None
    i = 0

    while i < len(lines):
        line = lines[i].strip()

        # Detect group headers - they're followed by Required/Optional
        if i + 1 < len(lines):
            next_line = lines[i + 1].strip()
            is_group_header = (
                ("Required" in next_line or "Optional" in next_line)
                and len(line) > 2
                and len(line) < 80
                and not line.startswith("+$")
                and not line.startswith("$")
                and line not in ("Your recommended options",)
            )
            if is_group_header:
                if current_group:
                    groups.append(current_group)
                req_type = "Required" if "Required" in next_line else "Optional"
                select_info = next_line
                current_group = {
                    "name": line,
                    "type": req_type,
                    "selectInfo": select_info,
                    "options": [],
                }
                i += 2  # skip the requirement line
                continue

        # Detect options - they have a price line following
        if current_group and line and not line.startswith("$") and len(line) < 100:
            # Check if next line is a price
            if i + 1 < len(lines):
                price_line = lines[i + 1].strip()
                if price_line.startswith("+$") or price_line == "$0.00":
                    current_group["options"].append({
                        "name": line,
                        "price": price_line,
                    })
                    i += 2
                    continue
            # Option without explicit price (like radio buttons)
            if current_group and line and not any(
                skip in line
                for skip in ["Required", "Optional", "Select", "Choose", "Preferences", "Add Special", "Make"]
            ):
                # Check if it looks like a standalone option (no price)
                if len(line) < 60 and not line.startswith("#"):
                    current_group["options"].append({
                        "name": line,
                        "price": "",
                    })

        i += 1

    if current_group:
        groups.append(current_group)

    return groups


async def main():
    print("=" * 60)
    print("  2AM Project - Modifier Scraper")
    print("=" * 60)

    all_modifiers = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()

        print(f"\nNavigating to DoorDash...")
        try:
            await page.goto(DOORDASH_URL, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            print(f"  Warning: {e}")

        await page.wait_for_timeout(5000)
        print(f"Scraping modifiers for {len(ITEMS_TO_CHECK)} items...\n")

        for idx, item_name in enumerate(ITEMS_TO_CHECK):
            print(f"  [{idx+1}/{len(ITEMS_TO_CHECK)}] {item_name}...", end=" ", flush=True)

            raw_text = await click_item_and_get_modifiers(page, item_name)

            if raw_text:
                modifiers = parse_modifiers(raw_text)
                all_modifiers[item_name] = {
                    "raw": raw_text[:2000],
                    "modifiers": modifiers,
                }
                mod_count = sum(len(g["options"]) for g in modifiers)
                print(f"{len(modifiers)} groups, {mod_count} options")
            else:
                all_modifiers[item_name] = {"raw": None, "modifiers": []}
                print("not found")

        await browser.close()

    # Save to JSON
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_modifiers, f, indent=2, ensure_ascii=False)

    print(f"\nSaved modifier data to: {OUTPUT_FILE}")
    print(f"Items with modifiers: {sum(1 for v in all_modifiers.values() if v['modifiers'])}")
    print(f"Items without modifiers: {sum(1 for v in all_modifiers.values() if not v['modifiers'])}")


if __name__ == "__main__":
    asyncio.run(main())
