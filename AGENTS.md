# Arcane PM design references

The approved images below govern Arcane PM's visual implementation. Open the
matching light, dark, and mobile references before changing a surface. Use the
original Arcane PM brand board throughout the application and public website.

| Surface | Approved references |
| --- | --- |
| Product mark and light/dark identity | [Brand board](docs/images/arcane-pm-brand.png) |
| Application project team | [Light](docs/images/arcane-pm-team-light.png), [dark](docs/images/arcane-pm-team-dark.png) |
| Application context handoff | [Handoff](docs/images/arcane-pm-handoff.png) |
| Application archive and file cleanup | [Tidy up](docs/images/arcane-pm-tidy-up.png) |
| Public marketing home | [Light](docs/images/arcane-pm-home-light.png), [dark](docs/images/arcane-pm-home-dark.png), [mobile light/dark](docs/images/arcane-pm-home-mobile.png) |
| Public developer documentation | [Light](docs/images/arcane-pm-docs-light.png), [dark](docs/images/arcane-pm-docs-dark.png), [mobile light/dark](docs/images/arcane-pm-docs-mobile.png) |
| README cover | [Header](docs/images/arcane-pm-header.png) |

[The original design prompts](docs/designs/image-prompts.md) explain each
composition and its intended adaptation. Preserve the images and prompts as
references; implement the interface with working controls and actual state.
Illustrative sample tasks and statuses in an image are not application data.

## Visual implementation

Light uses warm ivory, deep teal text and primary actions, muted gold, and
restrained pale mint/lavender surfaces. Dark uses deep desaturated teal, warm
ivory text, mint actions, pale lavender secondary text, and muted gold. Preserve
the product's rounded upright triangle, open orbit, detached dot, and central
four-point gold spark. Shared SDK mechanics remain reusable; their default
palette or parent logo does not replace this approved product identity.

Match the relevant reference's geometry, adult typography, generous spacing,
fine dividers, restrained panels, modest rounding, portrait emphasis,
navigation, and control placement. Preserve the fixed shell and one main
scroll surface. Prefer focused pages over long scrolling. The docs mobile
reference uses a compact header, collapsed Browse docs control, stacked
responsibilities, topic links, and a small guide beside the next-page link;
its desktop reference retains the three-column documentation composition.

Before delivering an application visual change, compare the actual built-app result
with the matching approved light and dark images and applicable mobile board.
Keep complete content, working actions, chosen faces, and truthful states.
State any remaining differences precisely. A pushed source change or a general
navigation check alone does not establish visual fidelity. Include these exact
reference paths in every visual-work handoff to another owner.

## October 6, 2026 correction

The manager's UI handoff omitted the exact approved images. The delivered
screenshots then departed from the approved palette, branding, layout, and
control placement, and were accepted without a matching-reference comparison.
Roshi had to identify the drift and supply the approved design again, wasting
review effort and damaging trust. Carry the reference mapping and comparison
requirement above into every subsequent visual change; an additional redesign
does not resolve this failure.

## Built-app acceptance and app-scoped control

Verify Arcane PM application behavior, models, integrations, and visual fidelity
in the actual built app with that app's actual Core and existing profile. Use
supported app-scoped inspection, screenshots, and input that operate only on the
app. Acceptance must preserve the app's ordinary origin, saved data, models, and
Core lifecycle. Source-preview results do not establish packaged-app acceptance.

Do not run Arcane PM browser-preview testing or browser model trials. Do not use
whole-desktop control, foreground input, or window activation for app acceptance.
Preserve the user's existing browser tabs and state; this correction does not
authorize closing them, resetting profiles, clearing caches, or repeating model
operations. This application requirement supersedes older browser-verification
permissions for this project.

The published SDK owns reusable app-control capabilities. Adopt them through its
public package and API, then build through `npm run build:windows`, which retains
one completed Windows app and preserves profiles, models, and runtime caches.
Keep source delivery, selected-package verification, SDK publication, and actual
built-app acceptance distinct. If a required app-control capability is pending,
continue its owner-level delivery and report the exact pending operation. Do not
replace built-app acceptance with browser testing or desktop automation. Carry
this requirement and the exact approved design references into every delegate
and handoff; existing authorization continues through delivery without asking
Roshi to repeat it.

### October 6, 2026 repeated verification-path correction

The manager continued browser verification after Roshi had repeatedly requested
testing in the built app without taking over his desktop. This failed to enforce
the requested acceptance path, wasted Roshi's review time, and forced him to
repeat the requirement. Roshi directed browser testing to stop. The permanent
correction is supported app-scoped control of the actual built app, followed by
acceptance there. Earlier browser observations remain historical evidence only;
they do not complete the outstanding native acceptance or avatar outcomes.
