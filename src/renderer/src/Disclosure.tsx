import { Children, cloneElement, createContext, isValidElement, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'

export const DisclosureState = createContext<Map<string, boolean> | undefined>(undefined)

// Only explicit user choices are saved. Automatic defaults may change when a
// stage ends without an onToggle event accidentally turning them into overrides.
export function useDisclosure(storageKey: string, defaultOpen = false) {
  const saved = useContext(DisclosureState)
  const [choice, setChoice] = useState<{ key: string; open: boolean }>()
  const open = (choice?.key === storageKey ? choice.open : saved?.get(storageKey)) ?? defaultOpen
  const setOpen = (value: boolean) => {
    saved?.set(storageKey, value)
    setChoice({ key: storageKey, open: value })
  }
  return [open, setOpen] as const
}

export function Disclosure({ storageKey, defaultOpen = false, forceOpen = false, open: controlledOpen, onOpenChange, children, ...props }: ComponentPropsWithoutRef<'details'> & { storageKey: string; defaultOpen?: boolean; forceOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [chosenOpen, setOpen] = useDisclosure(storageKey, defaultOpen)
  const open = forceOpen || (controlledOpen ?? chosenOpen)
  const ref = useRef<HTMLDetailsElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    const summary = node?.querySelector<HTMLElement>(':scope > summary')
    if (!open && node?.contains(document.activeElement) && !summary?.contains(document.activeElement)) summary?.focus({ preventScroll: true })
  }, [open])
  return <details {...props} ref={ref} open={open} data-expanded={open} onClickCapture={event => {
    const target = event.target instanceof Element ? event.target : undefined
    const summary = target?.closest('summary')
    if (summary?.parentElement !== event.currentTarget || target?.closest('button, a, input')) return
    // Keep nested controls independent and prevent a second native toggle on
    // double-click. Keyboard activation also produces a click (detail = 0).
    event.preventDefault()
    if (!forceOpen && event.detail < 2) (onOpenChange || setOpen)(!open)
  }}>{Children.map(children, child => isValidElement<ComponentPropsWithoutRef<'summary'>>(child) && child.type === 'summary'
    ? cloneElement(child, { 'aria-expanded': open }) : child)}</details>
}
