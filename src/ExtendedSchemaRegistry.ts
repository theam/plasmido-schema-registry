import { default as SchemaRegistry } from './SchemaRegistry'
import { AvroSchema, Schema, SchemaRegistryAPIClientOptions } from '@types'
import { SchemaRegistryAPIClientArgs } from './api'

export interface SubjectSchema {
  subject: string
  schema: Schema | AvroSchema,
  schemaId: number
}

export default class ExtendedSchemaRegistry extends SchemaRegistry {
  constructor(
    { auth, clientId, host, retry, agent }: SchemaRegistryAPIClientArgs,
    options?: SchemaRegistryAPIClientOptions,
  ) {
    super({ auth, clientId, host, retry, agent }, options)
  }

  public async getSubjects(): Promise<Array<string>> {
    const response = await this.api.Subject.all()
    return response.data()
  }

  public async getAllLatestSchemas(): Promise<Array<SubjectSchema>> {
    const subjects: Array<string> = await this.getSubjects()
    const map = []
    for (const subject of subjects) {
      const schemaId = await this.getLatestSchemaId(subject)
      const schema = await this.getSchema(schemaId)
      map.push({
        subject: subject,
        schema: schema,
        schemaId: schemaId
      } as SubjectSchema)
    }
    return map
  }
}
