# Heartbeat Vault Design System

## 1. Atmosphere & Identity

Heartbeat Vault is a quiet, trustworthy control room for consequential actions. Its signature is restrained assurance: neutral surfaces and precise typography keep attention on status and decisions, while emerald is reserved for the few moments where a user can safely move forward.

## 2. Color

### Palette

| Role              | Token                      | Light                 | Dark                  | Usage                         |
| ----------------- | -------------------------- | --------------------- | --------------------- | ----------------------------- |
| Surface/primary   | `--color-background`       | `hsl(0 0% 100%)`      | `hsl(240 10% 3.9%)`   | Page background               |
| Surface/secondary | `--color-secondary`        | `hsl(240 4.8% 95.9%)` | `hsl(240 3.7% 15.9%)` | Subtle grouping               |
| Surface/elevated  | `--color-card`             | `hsl(0 0% 100%)`      | `hsl(240 10% 3.9%)`   | Cards and dialogs             |
| Text/primary      | `--color-foreground`       | `hsl(240 10% 3.9%)`   | `hsl(0 0% 98%)`       | Headings and body             |
| Text/secondary    | `--color-muted-foreground` | `hsl(240 3.8% 46.1%)` | `hsl(240 5% 64.9%)`   | Hints and supporting copy     |
| Border/default    | `--color-border`           | `hsl(240 5.9% 90%)`   | `hsl(240 3.7% 15.9%)` | Inputs and surface separation |
| Accent/primary    | `--color-primary`          | `hsl(142 71% 45%)`    | `hsl(142 70% 45%)`    | Primary actions and focus     |
| Status/error      | `--color-destructive`      | `hsl(0 84.2% 60.2%)`  | `hsl(0 62.8% 30.6%)`  | Errors and dangerous actions  |

Accent is used for interactive elements, not decoration. No colors are introduced outside this palette without updating this table.

## 3. Typography

| Level   | Size | Weight | Line height | Usage                        |
| ------- | ---- | ------ | ----------- | ---------------------------- |
| H1      | 24px | 600    | 1.25        | Page titles                  |
| H2      | 20px | 600    | 1.3         | Card titles                  |
| Body    | 16px | 400    | 1.5         | Default copy                 |
| Body/sm | 14px | 400    | 1.5         | Supporting copy and controls |
| Caption | 12px | 500    | 1.4         | Field guidance and metadata  |

- Primary: `Geist`, `Inter`, system sans-serif.
- Mono: `Geist Mono`, `JetBrains Mono`, system monospace.
- Body text is never smaller than 14px; captions are reserved for secondary guidance.

## 4. Spacing & Layout

All spacing uses a 4px base unit: `space-1` 4px, `space-2` 8px, `space-3` 12px, `space-4` 16px, `space-6` 24px, `space-8` 32px, `space-12` 48px, `space-16` 64px.

- Narrow forms: 512px maximum width (`max-w-lg`).
- Application content: 1152px maximum width (`max-w-6xl`).
- Breakpoints: 640px, 768px, 1024px, 1280px, 1536px.
- Page-height regions use `min-h-[100dvh]`; layout spacing remains multiples of 4px.

## 5. Components

### Form field

- **Structure**: label, input, optional caption or error text.
- **Spacing**: 8px label-to-input, 4px caption-to-input.
- **States**: default, focus, disabled, invalid, submitting.
- **Accessibility**: explicit `htmlFor`/`id`, error referenced through `aria-describedby`, no placeholder-only labels.

### Select field

- **Structure**: the same label and control spacing as a text input, using the shared `Select` primitive.
- **States**: default, focus, disabled, and invalid when validation requires it.
- **Accessibility**: explicit `htmlFor`/`id`; the first option describes the unfiltered state.

### Card

- **Structure**: header, optional description, content.
- **Spacing**: 24px card padding with 16px internal groups.
- **States**: static by default; no hover elevation for workflow forms.
- **Accessibility**: semantic heading hierarchy remains owned by the page.

## 6. Motion & Interaction

- Micro-interactions: 150ms ease-out; panel changes: 200ms ease-in-out.
- Motion uses only opacity and transform and respects `prefers-reduced-motion`.
- Every interactive control provides hover, active, focus-visible, disabled, and submitting states.

## 7. Depth & Surface

The system uses a borders-only depth strategy. Cards, inputs, and separators use `--color-border`; shadows are not used to communicate hierarchy.
