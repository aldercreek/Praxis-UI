import { createContext, useContext, useState, type ComponentPropsWithoutRef } from 'react'

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

export function Disclosure({ storageKey, defaultOpen = false, forceOpen = false, children, ...props }: ComponentPropsWithoutRef<'details'> & { storageKey: string; defaultOpen?: boolean; forceOpen?: boolean }) {
  const [chosenOpen, setOpen] = useDisclosure(storageKey, defaultOpen)
  const open = forceOpen || chosenOpen
  return <details {...props} open={open} onToggle={event => {
    if (event.target !== event.currentTarget) return
    const value = event.currentTarget.open
    if (value !== open && !forceOpen) setOpen(value)
  }}>{children}</details>
}
