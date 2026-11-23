# Style references the owner supplied (2026-11-21)

The owner pasted two style write-ups in chat, one for Origin Financial and one for Apple. These are short notes on what each says and what Hydra kept. The final rules are in `../DESIGN.md` section 7. Where this file and section 7 differ, section 7 wins.

## Origin (dark, editorial)

What the write-up describes:
- Three type voices: a very light serif for big display lines, a neo-grotesque sans for UI, an uppercase mono for tiny labels.
- Flat surfaces. Depth comes from color steps between surfaces, not from shadows. One shadow in the whole system.
- One primary action style with the highest contrast on the page.
- Color is held back. Saturated color appears only on a few feature tiles and on data lines.
- Corners: 8 px on buttons, inputs and nav items; larger on cards.
- Motion: short eased state changes (about 0.2 s). No springs, no overshoot, no parallax.

What Hydra kept: flat surfaces, one high-contrast primary action, one strong dark block per page (the hero card), restrained motion, 8 px controls.
What Hydra dropped: the serif display voice, the mono labels, the colored tiles, the dark page.

## Apple (light, product gallery)

What the write-up describes:
- White canvas with pale gray bands. White cards with large soft corners. No shadows, no gradients.
- SF Pro for everything. Semibold headings with tight negative tracking. Small text also tracked slightly tight.
- Ink near `#1D1D1F`, secondary text in mid grays, hairline dividers.
- One blue, used only for links and small filled controls. Pill-shaped buttons and inputs.
- Status labels as plain colored text, not chips.
- Generous space. The product image is the event; UI stays quiet.

What Hydra kept: the system sans (SF Pro on the owner's devices), tight tracking, ink `#1D1D1F`, gray secondary text, hairlines, flat white surfaces, status as plain text, generous space.
What Hydra dropped: the blue accent (Hydra has no accent), pill controls and 28 px card corners (the owner asked for smaller corners), semibold weights (Hydra uses medium, to sit with the regular-weight logo).

## The owner's own reference images

- Monarch Money, Reports page: Sankey cash flow, four summary numbers above it, a collapsible sidebar.
- Origin app, home: net worth with a trend line, spend calendar, recent transactions, budget and credit cards.
- An expenses donut with totals under it.
- A three-headed hydra silhouette (tried for the logo, not picked).
