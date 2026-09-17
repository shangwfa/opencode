# Tailwind Design Tokens

`@xybot/ui` 配套 tokens。版本看 `node_modules/tailwindcss/package.json` 的 `version`：**v3** 把下方 v3 Tokens 写入 `tailwind.config.*` 的 `theme.extend`；**v4** 在主 CSS（含 `@import "tailwindcss"`）里用 `@theme inline { ... }` 写入 v4 Tokens。

---

## v3 Tokens

### fontSize

```js
fontSize: {
  sm: '13px',
},
```

### transitionDuration

```js
transitionDuration: {
  DEFAULT: '200ms',
},
```

### colors

```js
colors: {
  bgBase: {
    container: 'var(--bg-base-container)',
    containerSecondary: 'var(--bg-base-container-secondary)',
    layout: 'var(--bg-base-layout)',
    layoutSecondary: 'var(--bg-base-layout-secondary)',
    spotlight: 'var(--bg-base-spotlight)',
    spotlightSecondary: 'var(--bg-base-spotlight-secondary)',
    mask: 'var(--bg-base-mask)',
  },
  bgFillDeep: {
    quinary: 'var(--bg-fill-deep-quinary)',
    quaternary: 'var(--bg-fill-deep-quaternary)',
    tertiary: 'var(--bg-fill-deep-tertiary)',
    secondary: 'var(--bg-fill-deep-secondary)',
    default: 'var(--bg-fill-deep-default)',
  },
  bgFillShallow: {
    quinary: 'var(--bg-fill-shallow-quinary)',
    quaternary: 'var(--bg-fill-shallow-quaternary)',
    tertiary: 'var(--bg-fill-shallow-tertiary)',
    secondary: 'var(--bg-fill-shallow-secondary)',
    default: 'var(--bg-fill-shallow-default)',
  },
  bgPrimary: {
    spotlight: 'var(--bg-primary-spotlight)',
    spotlightSecondary: 'var(--bg-primary-spotlight-secondary)',
    quaternary: 'var(--bg-primary-quaternary)',
    tertiary: 'var(--bg-primary-tertiary)',
    secondary: 'var(--bg-primary-secondary)',
    default: 'var(--bg-primary-default)',
  },
  bgInfo: {
    spotlight: 'var(--bg-info-spotlight)',
    spotlightSecondary: 'var(--bg-info-spotlight-secondary)',
    quaternary: 'var(--bg-info-quaternary)',
    tertiary: 'var(--bg-info-tertiary)',
    secondary: 'var(--bg-info-secondary)',
    default: 'var(--bg-info-default)',
  },
  bgSuccess: {
    spotlight: 'var(--bg-success-spotlight)',
    spotlightSecondary: 'var(--bg-success-spotlight-secondary)',
    quaternary: 'var(--bg-success-quaternary)',
    tertiary: 'var(--bg-success-tertiary)',
    secondary: 'var(--bg-success-secondary)',
    default: 'var(--bg-success-default)',
  },
  bgWarning: {
    spotlight: 'var(--bg-warning-spotlight)',
    spotlightSecondary: 'var(--bg-warning-spotlight-secondary)',
    quaternary: 'var(--bg-warning-quaternary)',
    tertiary: 'var(--bg-warning-tertiary)',
    secondary: 'var(--bg-warning-secondary)',
    default: 'var(--bg-warning-default)',
  },
  bgMagic: {
    spotlight: 'var(--bg-magic-spotlight)',
    spotlightSecondary: 'var(--bg-magic-spotlight-secondary)',
    quaternary: 'var(--bg-magic-quaternary)',
    tertiary: 'var(--bg-magic-tertiary)',
    secondary: 'var(--bg-magic-secondary)',
    default: 'var(--bg-magic-default)',
  },
  bgError: {
    spotlight: 'var(--bg-error-spotlight)',
    spotlightSecondary: 'var(--bg-error-spotlight-secondary)',
    quaternary: 'var(--bg-error-quaternary)',
    tertiary: 'var(--bg-error-tertiary)',
    secondary: 'var(--bg-error-secondary)',
    default: 'var(--bg-error-default)',
  },
  textBase: {
    default: 'var(--text-base-default)',
    secondary: 'var(--text-base-secondary)',
    tertiary: 'var(--text-base-tertiary)',
    quaternary: 'var(--text-base-quaternary)',
    inGrayDefault: 'var(--text-base-in-gray-default)',
    inGraySecondary: 'var(--text-base-in-gray-secondary)',
    inGrayTertiary: 'var(--text-base-in-gray-tertiary)',
    inGrayDisable: 'var(--text-base-in-gray-disable)',
    inColorDefault: 'var(--text-base-in-coloer-default)',
    inColorSecondary: 'var(--text-base-in-coloer-secondary)',
    inColorTertiary: 'var(--text-base-in-coloer-tertiary)',
    inColorDisable: 'var(--text-base-in-coloer-disable)',
  },
  textPrimary: {
    default: 'var(--text-primary-default)',
    defaultHover: 'var(--text-primary-default-hover)',
    secondary: 'var(--text-primary-secondary)',
    tertiary: 'var(--text-primary-tertiary)',
  },
  textInfo: {
    default: 'var(--text-info-default)',
    defaultHover: 'var(--text-info-default-hover)',
    secondary: 'var(--text-info-secondary)',
    tertiary: 'var(--text-info-tertiary)',
  },
  textSuccess: {
    default: 'var(--text-success-default)',
    defaultHover: 'var(--text-success-default-hover)',
    secondary: 'var(--text-success-secondary)',
    tertiary: 'var(--text-success-tertiary)',
  },
  textWarning: {
    default: 'var(--text-warning-default)',
    defaultHover: 'var(--text-warning-default-hover)',
    secondary: 'var(--text-warning-secondary)',
    tertiary: 'var(--text-warning-tertiary)',
  },
  textError: {
    default: 'var(--text-error-default)',
    defaultHover: 'var(--text-error-default-hover)',
    secondary: 'var(--text-error-secondary)',
    tertiary: 'var(--text-error-tertiary)',
  },
  textMagic: {
    default: 'var(--text-magic-default)',
    defaultHover: 'var(--text-magic-default-hover)',
    secondary: 'var(--text-magic-secondary)',
    tertiary: 'var(--text-magic-tertiary)',
  },
  borderBase: {
    default: 'var(--border-base-default)',
    secondary: 'var(--border-base-secondary)',
    tertiary: 'var(--border-base-tertiary)',
    quaternary: 'var(--border-base-quaternary)',
  },
  borderSpecular: {
    default: 'var(--border-specular-default)',
    secondary: 'var(--border-specular-secondary)',
    tertiary: 'var(--border-specular-tertiary)',
    quaternary: 'var(--border-specular-quaternary)',
  },
  borderPrimary: {
    default: 'var(--border-primary-default)',
    secondary: 'var(--border-primary-secondary)',
    tertiary: 'var(--border-primary-tertiary)',
    quaternary: 'var(--border-primary-quaternary)',
  },
  borderInfo: {
    default: 'var(--border-info-default)',
    secondary: 'var(--border-info-secondary)',
    tertiary: 'var(--border-info-tertiary)',
    quaternary: 'var(--border-info-quaternary)',
  },
  borderSuccess: {
    default: 'var(--border-success-default)',
    secondary: 'var(--border-success-secondary)',
    tertiary: 'var(--border-success-tertiary)',
    quaternary: 'var(--border-success-quaternary)',
  },
  borderWarning: {
    default: 'var(--border-warning-default)',
    secondary: 'var(--border-warning-secondary)',
    tertiary: 'var(--border-warning-tertiary)',
    quaternary: 'var(--border-warning-quaternary)',
  },
  borderError: {
    default: 'var(--border-error-default)',
    secondary: 'var(--border-error-secondary)',
    tertiary: 'var(--border-error-tertiary)',
    quaternary: 'var(--border-error-quaternary)',
  },
  effectShadow: {
    default: 'var(--effect-shadow-default)',
    secondary: 'var(--effect-shadow-secondary)',
  },
},
```

---

## v4 Tokens

v4 使用 `--color-<name>-<variant>` 命名约定，在 `@theme inline` 块中定义。

### fontSize & transitionDuration

```css
--font-size-sm: 13px;
--transition-duration-default: 200ms;
```

### colors

```css
/* bgBase */
--color-bgBase-container: var(--bg-base-container);
--color-bgBase-containerSecondary: var(--bg-base-container-secondary);
--color-bgBase-layout: var(--bg-base-layout);
--color-bgBase-layoutSecondary: var(--bg-base-layout-secondary);
--color-bgBase-spotlight: var(--bg-base-spotlight);
--color-bgBase-spotlightSecondary: var(--bg-base-spotlight-secondary);
--color-bgBase-mask: var(--bg-base-mask);

/* bgFillDeep */
--color-bgFillDeep-quinary: var(--bg-fill-deep-quinary);
--color-bgFillDeep-quaternary: var(--bg-fill-deep-quaternary);
--color-bgFillDeep-tertiary: var(--bg-fill-deep-tertiary);
--color-bgFillDeep-secondary: var(--bg-fill-deep-secondary);
--color-bgFillDeep-default: var(--bg-fill-deep-default);

/* bgFillShallow */
--color-bgFillShallow-quinary: var(--bg-fill-shallow-quinary);
--color-bgFillShallow-quaternary: var(--bg-fill-shallow-quaternary);
--color-bgFillShallow-tertiary: var(--bg-fill-shallow-tertiary);
--color-bgFillShallow-secondary: var(--bg-fill-shallow-secondary);
--color-bgFillShallow-default: var(--bg-fill-shallow-default);

/* bgPrimary */
--color-bgPrimary-spotlight: var(--bg-primary-spotlight);
--color-bgPrimary-spotlightSecondary: var(--bg-primary-spotlight-secondary);
--color-bgPrimary-quaternary: var(--bg-primary-quaternary);
--color-bgPrimary-tertiary: var(--bg-primary-tertiary);
--color-bgPrimary-secondary: var(--bg-primary-secondary);
--color-bgPrimary-default: var(--bg-primary-default);

/* bgInfo */
--color-bgInfo-spotlight: var(--bg-info-spotlight);
--color-bgInfo-spotlightSecondary: var(--bg-info-spotlight-secondary);
--color-bgInfo-quaternary: var(--bg-info-quaternary);
--color-bgInfo-tertiary: var(--bg-info-tertiary);
--color-bgInfo-secondary: var(--bg-info-secondary);
--color-bgInfo-default: var(--bg-info-default);

/* bgSuccess */
--color-bgSuccess-spotlight: var(--bg-success-spotlight);
--color-bgSuccess-spotlightSecondary: var(--bg-success-spotlight-secondary);
--color-bgSuccess-quaternary: var(--bg-success-quaternary);
--color-bgSuccess-tertiary: var(--bg-success-tertiary);
--color-bgSuccess-secondary: var(--bg-success-secondary);
--color-bgSuccess-default: var(--bg-success-default);

/* bgWarning */
--color-bgWarning-spotlight: var(--bg-warning-spotlight);
--color-bgWarning-spotlightSecondary: var(--bg-warning-spotlight-secondary);
--color-bgWarning-quaternary: var(--bg-warning-quaternary);
--color-bgWarning-tertiary: var(--bg-warning-tertiary);
--color-bgWarning-secondary: var(--bg-warning-secondary);
--color-bgWarning-default: var(--bg-warning-default);

/* bgMagic */
--color-bgMagic-spotlight: var(--bg-magic-spotlight);
--color-bgMagic-spotlightSecondary: var(--bg-magic-spotlight-secondary);
--color-bgMagic-quaternary: var(--bg-magic-quaternary);
--color-bgMagic-tertiary: var(--bg-magic-tertiary);
--color-bgMagic-secondary: var(--bg-magic-secondary);
--color-bgMagic-default: var(--bg-magic-default);

/* bgError */
--color-bgError-spotlight: var(--bg-error-spotlight);
--color-bgError-spotlightSecondary: var(--bg-error-spotlight-secondary);
--color-bgError-quaternary: var(--bg-error-quaternary);
--color-bgError-tertiary: var(--bg-error-tertiary);
--color-bgError-secondary: var(--bg-error-secondary);
--color-bgError-default: var(--bg-error-default);

/* textBase */
--color-textBase-default: var(--text-base-default);
--color-textBase-secondary: var(--text-base-secondary);
--color-textBase-tertiary: var(--text-base-tertiary);
--color-textBase-quaternary: var(--text-base-quaternary);
--color-textBase-inGrayDefault: var(--text-base-in-gray-default);
--color-textBase-inGraySecondary: var(--text-base-in-gray-secondary);
--color-textBase-inGrayTertiary: var(--text-base-in-gray-tertiary);
--color-textBase-inGrayDisable: var(--text-base-in-gray-disable);
--color-textBase-inColorDefault: var(--text-base-in-coloer-default);
--color-textBase-inColorSecondary: var(--text-base-in-coloer-secondary);
--color-textBase-inColorTertiary: var(--text-base-in-coloer-tertiary);
--color-textBase-inColorDisable: var(--text-base-in-coloer-disable);

/* textPrimary */
--color-textPrimary-default: var(--text-primary-default);
--color-textPrimary-defaultHover: var(--text-primary-default-hover);
--color-textPrimary-secondary: var(--text-primary-secondary);
--color-textPrimary-tertiary: var(--text-primary-tertiary);

/* textInfo */
--color-textInfo-default: var(--text-info-default);
--color-textInfo-defaultHover: var(--text-info-default-hover);
--color-textInfo-secondary: var(--text-info-secondary);
--color-textInfo-tertiary: var(--text-info-tertiary);

/* textSuccess */
--color-textSuccess-default: var(--text-success-default);
--color-textSuccess-defaultHover: var(--text-success-default-hover);
--color-textSuccess-secondary: var(--text-success-secondary);
--color-textSuccess-tertiary: var(--text-success-tertiary);

/* textWarning */
--color-textWarning-default: var(--text-warning-default);
--color-textWarning-defaultHover: var(--text-warning-default-hover);
--color-textWarning-secondary: var(--text-warning-secondary);
--color-textWarning-tertiary: var(--text-warning-tertiary);

/* textError */
--color-textError-default: var(--text-error-default);
--color-textError-defaultHover: var(--text-error-default-hover);
--color-textError-secondary: var(--text-error-secondary);
--color-textError-tertiary: var(--text-error-tertiary);

/* textMagic */
--color-textMagic-default: var(--text-magic-default);
--color-textMagic-defaultHover: var(--text-magic-default-hover);
--color-textMagic-secondary: var(--text-magic-secondary);
--color-textMagic-tertiary: var(--text-magic-tertiary);

/* borderBase */
--color-borderBase-default: var(--border-base-default);
--color-borderBase-secondary: var(--border-base-secondary);
--color-borderBase-tertiary: var(--border-base-tertiary);
--color-borderBase-quaternary: var(--border-base-quaternary);

/* borderSpecular */
--color-borderSpecular-default: var(--border-specular-default);
--color-borderSpecular-secondary: var(--border-specular-secondary);
--color-borderSpecular-tertiary: var(--border-specular-tertiary);
--color-borderSpecular-quaternary: var(--border-specular-quaternary);

/* borderPrimary */
--color-borderPrimary-default: var(--border-primary-default);
--color-borderPrimary-secondary: var(--border-primary-secondary);
--color-borderPrimary-tertiary: var(--border-primary-tertiary);
--color-borderPrimary-quaternary: var(--border-primary-quaternary);

/* borderInfo */
--color-borderInfo-default: var(--border-info-default);
--color-borderInfo-secondary: var(--border-info-secondary);
--color-borderInfo-tertiary: var(--border-info-tertiary);
--color-borderInfo-quaternary: var(--border-info-quaternary);

/* borderSuccess */
--color-borderSuccess-default: var(--border-success-default);
--color-borderSuccess-secondary: var(--border-success-secondary);
--color-borderSuccess-tertiary: var(--border-success-tertiary);
--color-borderSuccess-quaternary: var(--border-success-quaternary);

/* borderWarning */
--color-borderWarning-default: var(--border-warning-default);
--color-borderWarning-secondary: var(--border-warning-secondary);
--color-borderWarning-tertiary: var(--border-warning-tertiary);
--color-borderWarning-quaternary: var(--border-warning-quaternary);

/* borderError */
--color-borderError-default: var(--border-error-default);
--color-borderError-secondary: var(--border-error-secondary);
--color-borderError-tertiary: var(--border-error-tertiary);
--color-borderError-quaternary: var(--border-error-quaternary);

/* effectShadow */
--color-effectShadow-default: var(--effect-shadow-default);
--color-effectShadow-secondary: var(--effect-shadow-secondary);
```

---

**使用**：自写 DOM 用 token class（如 `bg-bgBase-container`、`text-textPrimary-default`），禁止硬编码 hex/rgb。
