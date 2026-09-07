import { definePreset } from '@primeuix/themes';
import Aura from '@primeng/themes/aura';

/**
 * PrimeNG's Aura theme, rebound onto this app's own design tokens
 * (styles/tokens.css) rather than Aura's stock palette — the PrimeNG
 * equivalent of what styles/material-theme.scss did for Angular Material.
 *
 * Every value below is a `var(--...)` reference into tokens.css, not a
 * literal color: tokens.css already resolves light vs dark under the
 * `[data-theme='dark']` attribute ThemeService sets on <html>, so the same
 * binding here serves both themes with no separate dark block needed — the
 * one exception is `colorScheme`, which PrimeNG itself branches on for a
 * handful of internal defaults, so light/dark are still spelled out there
 * with identical (var-based) values.
 *
 * Anything PrimeNG's design tokens can't express (flat/no-elevation,
 * hairline borders as real borders, this app's tighter control heights) is
 * layered on top in styles/primeng-overrides.css instead, the same split
 * material-theme.scss used ("system-token binding" vs "component
 * overrides").
 */
const surfacePalette = {
  0: 'var(--bg-canvas)',
  50: 'var(--bg-surface)',
  100: 'var(--bg-surface)',
  200: 'var(--border-subtle)',
  300: 'var(--border-subtle)',
  400: 'var(--line-strong)',
  500: 'var(--text-muted)',
  600: 'var(--text-muted)',
  700: 'var(--tx-2)',
  800: 'var(--text-main)',
  900: 'var(--text-main)',
  950: 'var(--text-main)',
};

const primaryPalette = {
  50: 'var(--acc-soft)',
  100: 'var(--acc-soft)',
  200: 'var(--acc-line)',
  300: 'var(--acc-line)',
  400: 'var(--brand-primary)',
  500: 'var(--brand-primary)',
  600: 'var(--brand-primary)',
  700: 'var(--acc-tx)',
  800: 'var(--acc-tx)',
  900: 'var(--acc-tx)',
  950: 'var(--acc-tx)',
};

const colorSchemeShared = {
  primary: {
    color: 'var(--brand-primary)',
    inverseColor: '#ffffff',
    hoverColor: 'var(--acc-tx)',
    activeColor: 'var(--acc-tx)',
  },
  formField: {
    background: 'var(--bg-surface)',
    disabledBackground: 'var(--bg-hover)',
    filledBackground: 'var(--bg-surface)',
    filledHoverBackground: 'var(--bg-hover)',
    filledFocusBackground: 'var(--bg-surface)',
    borderColor: 'var(--border-subtle)',
    hoverBorderColor: 'var(--line-strong)',
    focusBorderColor: 'var(--brand-primary)',
    invalidBorderColor: 'var(--market-down)',
    color: 'var(--text-main)',
    disabledColor: 'var(--text-muted)',
    placeholderColor: 'var(--text-muted)',
    invalidPlaceholderColor: 'var(--market-down)',
    floatLabelColor: 'var(--text-muted)',
    floatLabelFocusColor: 'var(--brand-primary)',
    floatLabelInvalidColor: 'var(--market-down)',
    iconColor: 'var(--text-muted)',
  },
  text: {
    color: 'var(--text-main)',
    hoverColor: 'var(--text-main)',
    mutedColor: 'var(--text-muted)',
    hoverMutedColor: 'var(--text-main)',
  },
  content: {
    background: 'var(--bg-surface)',
    hoverBackground: 'var(--bg-hover)',
    borderColor: 'var(--border-subtle)',
    color: 'var(--text-main)',
    hoverColor: 'var(--text-main)',
  },
  overlay: {
    select: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      color: 'var(--text-main)',
    },
    popover: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      color: 'var(--text-main)',
    },
    modal: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      color: 'var(--text-main)',
    },
  },
  list: {
    option: {
      focusBackground: 'var(--bg-hover)',
      selectedBackground: 'var(--acc-soft)',
      selectedFocusBackground: 'var(--acc-soft)',
      color: 'var(--text-main)',
      focusColor: 'var(--text-main)',
      selectedColor: 'var(--acc-tx)',
      selectedFocusColor: 'var(--acc-tx)',
    },
  },
  mask: {
    background: 'rgba(0, 0, 0, 0.6)',
    color: 'var(--text-main)',
  },
};

/**
 * Component-level tokens.
 *
 * The semantic tokens above get colour right almost everywhere; what remains
 * is the same two things material-theme.scss's own "Component overrides"
 * section called out: this is a flat surface (no shadow) with real 1px
 * hairline borders standing in for elevation, and every control runs denser
 * than PrimeNG's own touch-sized defaults. Radii reuse the --r-* scale from
 * tokens.css so a card and a hand-written .panel still round the same.
 */
const components = {
  card: {
    root: {
      background: 'var(--bg-surface)',
      borderRadius: 'var(--r-lg)',
      color: 'var(--text-main)',
      shadow: 'none',
    },
    body: { padding: 'var(--s5)', gap: 'var(--s3)' },
    subtitle: { color: 'var(--text-muted)' },
  },
  button: {
    root: {
      borderRadius: 'var(--r-sm)',
      paddingX: 'var(--s4)',
      paddingY: 'var(--s2)',
      focusRingWidth: '1px',
      raisedShadow: 'none',
    },
    primary: {
      background: 'var(--brand-primary)',
      hoverBackground: 'var(--acc-tx)',
      activeBackground: 'var(--acc-tx)',
      borderColor: 'var(--brand-primary)',
      hoverBorderColor: 'var(--acc-tx)',
      activeBorderColor: 'var(--acc-tx)',
      color: '#ffffff',
      hoverColor: '#ffffff',
      activeColor: '#ffffff',
    },
    outlinedPrimary: {
      hoverBackground: 'var(--bg-hover)',
      activeBackground: 'var(--bg-hover)',
      borderColor: 'var(--border-subtle)',
      color: 'var(--text-main)',
    },
    textPrimary: {
      hoverBackground: 'var(--bg-hover)',
      activeBackground: 'var(--bg-hover)',
      color: 'var(--acc-tx)',
    },
  },
  chip: {
    root: {
      borderRadius: 'var(--r-sm)',
      paddingX: 'var(--s3)',
      paddingY: '4px',
      background: 'var(--surf-2)',
      color: 'var(--text-main)',
    },
  },
  checkbox: {
    root: {
      borderRadius: 'var(--r-xs)',
      background: 'var(--bg-surface)',
      borderColor: 'var(--line-strong)',
      hoverBorderColor: 'var(--text-muted)',
      checkedBackground: 'var(--brand-primary)',
      checkedHoverBackground: 'var(--acc-tx)',
      checkedBorderColor: 'var(--brand-primary)',
      checkedHoverBorderColor: 'var(--acc-tx)',
      focusRingWidth: '1px',
    },
    icon: { checkedColor: '#ffffff', checkedHoverColor: '#ffffff' },
  },
  toggleswitch: {
    root: {
      background: 'var(--bg-hover)',
      checkedBackground: 'var(--brand-primary)',
      checkedHoverBackground: 'var(--brand-primary)',
      borderColor: 'transparent',
      focusRingWidth: '1px',
    },
    handle: {
      background: 'var(--text-muted)',
      hoverBackground: 'var(--text-main)',
      checkedBackground: '#ffffff',
      checkedHoverBackground: '#ffffff',
    },
  },
  selectbutton: {
    root: { borderRadius: 'var(--r-sm)' },
  },
  popover: {
    root: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      color: 'var(--text-main)',
      borderRadius: 'var(--r-lg)',
      shadow: 'var(--sh-3)',
    },
  },
  select: {
    root: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      hoverBorderColor: 'var(--line-strong)',
      focusBorderColor: 'var(--brand-primary)',
      color: 'var(--text-main)',
      paddingX: 'var(--s3)',
      paddingY: 'var(--s2)',
      borderRadius: 'var(--r-sm)',
      focusRingWidth: '1px',
    },
    overlay: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      borderRadius: 'var(--r-sm)',
      shadow: 'var(--sh-3)',
    },
    option: {
      focusBackground: 'var(--bg-hover)',
      selectedBackground: 'var(--acc-soft)',
      selectedFocusBackground: 'var(--acc-soft)',
      color: 'var(--text-main)',
      selectedColor: 'var(--acc-tx)',
    },
  },
  autocomplete: {
    root: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      hoverBorderColor: 'var(--line-strong)',
      focusBorderColor: 'var(--brand-primary)',
      color: 'var(--text-main)',
      paddingX: 'var(--s3)',
      paddingY: 'var(--s2)',
      borderRadius: 'var(--r-sm)',
      focusRingWidth: '1px',
    },
    overlay: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      borderRadius: 'var(--r-lg)',
      shadow: 'var(--sh-3)',
    },
    option: {
      focusBackground: 'var(--bg-hover)',
      selectedBackground: 'var(--acc-soft)',
      color: 'var(--text-main)',
      selectedColor: 'var(--acc-tx)',
    },
  },
  progressbar: {
    root: {
      background: 'var(--border-subtle)',
      borderRadius: 'var(--r-pill)',
      height: '4px',
    },
    value: { background: 'var(--brand-primary)' },
  },
  progressspinner: {
    root: {
      colorOne: 'var(--brand-primary)',
      colorTwo: 'var(--brand-primary)',
      colorThree: 'var(--brand-primary)',
      colorFour: 'var(--brand-primary)',
    },
  },
  inputtext: {
    root: {
      background: 'var(--bg-surface)',
      borderColor: 'var(--border-subtle)',
      hoverBorderColor: 'var(--line-strong)',
      focusBorderColor: 'var(--brand-primary)',
      color: 'var(--text-main)',
      placeholderColor: 'var(--text-muted)',
      paddingX: 'var(--s3)',
      paddingY: 'var(--s2)',
      borderRadius: 'var(--r-sm)',
      focusRingWidth: '1px',
    },
  },
  datatable: {
    root: { borderColor: 'var(--border-subtle)' },
    headerCell: {
      background: 'transparent',
      hoverBackground: 'var(--bg-hover)',
      color: 'var(--text-muted)',
      borderColor: 'var(--border-subtle)',
    },
    row: {
      background: 'transparent',
      hoverBackground: 'var(--bg-hover)',
      color: 'var(--text-main)',
    },
    bodyCell: { borderColor: 'var(--border-subtle)' },
  },
};

export const AppPreset = definePreset(Aura, {
  components,
  semantic: {
    primary: primaryPalette,
    formField: {
      paddingX: 'var(--s3)',
      paddingY: 'var(--s2)',
      borderRadius: 'var(--r-sm)',
    },
    borderRadius: {
      none: '0',
      xs: 'var(--r-xs)',
      sm: 'var(--r-sm)',
      md: 'var(--r-md)',
      lg: 'var(--r-lg)',
      xl: 'var(--r-xl)',
    },
    focusRing: {
      width: '1px',
      style: 'solid',
      color: 'var(--brand-primary)',
      offset: '0',
    },
    disabledOpacity: '0.6',
    colorScheme: {
      light: {
        surface: surfacePalette,
        ...colorSchemeShared,
      },
      dark: {
        surface: surfacePalette,
        ...colorSchemeShared,
      },
    },
  },
});
