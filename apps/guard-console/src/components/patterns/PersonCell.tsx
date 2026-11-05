import * as React from "react"
import { Badge, GeneratedAvatar } from "@vibtra/ui/react"
import type { ConsolePersonRow } from "@vibtra/console-api"

export interface PersonFacts {
  name?: string
  email?: string
  image?: string
}

export function usePeopleIndex(rows: readonly ConsolePersonRow[] | undefined): Map<string, PersonFacts> {
  return React.useMemo(
    () =>
      new Map(
        (rows ?? []).map(
          (r) => [r.subject, { email: r.email, ...(r.name ? { name: r.name } : {}), ...(r.image ? { image: r.image } : {}) }] as const,
        ),
      ),
    [rows],
  )
}

export const personWords = (id: string, person: PersonFacts | undefined, email?: string): string =>
  person?.name ?? person?.email ?? email ?? id

export function PersonCell({
  id,
  person,
  email,
  pill,
}: {
  id: string
  person?: PersonFacts
  email?: string
  pill?: string
}) {
  const mail = person?.email ?? email
  const name = person?.name
  const first = name ?? mail ?? id
  const second = name === undefined ? undefined : mail
  return (
    <span data-slot="person-cell" className="flex min-w-0 items-center gap-3">
      <GeneratedAvatar seed={mail ?? id} name={first} kind="person" photoUrl={person?.image} showTitle={false} className="size-8 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{first}</span>
          {pill === undefined ? null : (
            <Badge tone="ok" className="shrink-0">
              {pill}
            </Badge>
          )}
        </span>
        {second === undefined ? null : <span className="truncate text-muted-foreground">{second}</span>}
      </span>
    </span>
  )
}
