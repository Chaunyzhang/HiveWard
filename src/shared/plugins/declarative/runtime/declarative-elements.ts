/** JSX element factory for the guest `hiveward` module. Elements are plain data until rendered. */

export const HIVEWARD_ELEMENT = Symbol.for('hiveward.declarative.element')
export const Fragment = Symbol.for('hiveward.declarative.fragment')

export type HiveWardProps = Record<string, unknown>
/** Loosely typed on purpose: author-facing prop types live in the published `hiveward` typings. */
export type HiveWardComponent = (props: HiveWardProps) => unknown
export type HiveWardElementType = string | typeof Fragment | HiveWardComponent

export type HiveWardElement = {
  readonly $$typeof: typeof HIVEWARD_ELEMENT
  readonly type: HiveWardElementType
  readonly props: HiveWardProps
  readonly key: string | undefined
}

export function isHiveWardElement(value: unknown): value is HiveWardElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$$typeof' in value &&
    value.$$typeof === HIVEWARD_ELEMENT
  )
}

function createElement(type: HiveWardElementType, props: HiveWardProps, key: unknown): HiveWardElement {
  return Object.freeze({
    $$typeof: HIVEWARD_ELEMENT,
    type,
    props,
    key: key === undefined || key === null ? undefined : String(key)
  })
}

/** Automatic runtime (`jsx`/`jsxs`/`jsxDEV`): children arrive inside `props`. */
export function jsx(type: HiveWardElementType, props: HiveWardProps | null, key?: unknown): HiveWardElement {
  const { key: propKey, ...rest } = props ?? {}
  return createElement(type, rest, key ?? propKey)
}

/** Classic runtime (`h`, `jsxFactory`): children arrive as trailing arguments. */
export function h(
  type: HiveWardElementType,
  props: HiveWardProps | null,
  ...children: unknown[]
): HiveWardElement {
  const { key, ...rest } = props ?? {}
  if (children.length > 0) {
    rest.children = children.length === 1 ? children[0] : children
  }
  return createElement(type, rest, key)
}
