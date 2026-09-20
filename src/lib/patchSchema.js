import { z } from 'zod'

// Schema de PATCH a partir do schema de criação. `schema.partial()` sozinho NÃO serve:
// no zod 4 os `.default()` continuam valendo dentro de campos opcionais, então um PATCH
// com só { done: true } voltaria type/priority/value/etc. pros valores padrão e
// sobrescreveria o que estava salvo. Aqui os defaults saem antes do partial().
export function patchSchema(schema) {
  const shape = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = field instanceof z.ZodDefault ? field.unwrap() : field
  }
  return z.object(shape).partial()
}
