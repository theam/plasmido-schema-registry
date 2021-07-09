import { encode, MAGIC_BYTE } from './wireEncoder'
import decode from './wireDecoder'
import { COMPATIBILITY, DEFAULT_SEPERATOR } from './constants'
import API, { SchemaRegistryAPIClientArgs, SchemaRegistryAPIClient } from './api'
import Cache from './cache'
import {
  ConfluentSchemaRegistryError,
  ConfluentSchemaRegistryArgumentError,
  ConfluentSchemaRegistryCompatibilityError,
  ConfluentSchemaRegistryValidationError,
} from './errors'
import {
  Schema,
  RawAvroSchema,
  AvroSchema,
  SchemaType,
  ConfluentSchema,
  ConfluentSubject,
  SchemaRegistryAPIClientOptions,
  AvroConfluentSchema,
  ExtendedAvroSchema, ResponseSchema,
} from './@types'
import {
  helperTypeFromSchemaType,
  schemaTypeFromString,
  schemaFromConfluentSchema,
} from './schemaTypeResolver'

import { cloneDeep } from 'lodash'

export interface RegisteredSchema {
  id: number,
  subject: string
}

interface Opts {
  compatibility?: COMPATIBILITY
  separator?: string
  subject: string
}

const DEFAULT_OPTS = {
  compatibility: COMPATIBILITY.BACKWARD,
  separator: DEFAULT_SEPERATOR,
}

export default class SchemaRegistry {
  private api: SchemaRegistryAPIClient
  private options: SchemaRegistryAPIClientOptions | undefined

  public cache: Cache

  constructor(
    { auth, clientId, host, retry, agent }: SchemaRegistryAPIClientArgs,
    options?: SchemaRegistryAPIClientOptions,
  ) {
    this.api = API({ auth, clientId, host, retry, agent })
    this.cache = new Cache()
    this.options = options
  }

  private isConfluentSchema(
    schema: RawAvroSchema | AvroSchema | ConfluentSchema,
  ): schema is ConfluentSchema {
    return (schema as ConfluentSchema).schema != null
  }

  private getConfluentSchema(
    schema: RawAvroSchema | AvroSchema | ConfluentSchema,
  ): ConfluentSchema {
    let confluentSchema: ConfluentSchema
    // convert data from old api (for backwards compatibility)
    if (!this.isConfluentSchema(schema)) {
      // schema is instanceof RawAvroSchema or AvroSchema
      confluentSchema = {
        type: SchemaType.AVRO,
        schema: JSON.stringify(schema),
      }
    } else {
      confluentSchema = schema as ConfluentSchema
    }
    return confluentSchema
  }

  public async register(
    schema: Exclude<ConfluentSchema, AvroConfluentSchema>,
    userOpts: Opts,
  ): Promise<RegisteredSchema>
  public async register(
    schema: RawAvroSchema | AvroConfluentSchema,
    userOpts?: Omit<Opts, 'subject'> & { subject?: string },
  ): Promise<RegisteredSchema>
  public async register(
    schema: RawAvroSchema | ConfluentSchema,
    userOpts: Opts,
  ): Promise<RegisteredSchema>
  public async register(
    schema: RawAvroSchema | ConfluentSchema,
    userOpts?: Opts,
  ): Promise<RegisteredSchema> {
    const { compatibility, separator } = { ...DEFAULT_OPTS, ...userOpts }

    const confluentSchema: ConfluentSchema = this.getConfluentSchema(schema)

    const helper = helperTypeFromSchemaType(confluentSchema.type)
    const options = cloneDeep(this.options)
    const schemaInstance = schemaFromConfluentSchema(confluentSchema, options)
    helper.validate(schemaInstance)

    let subject: ConfluentSubject
    if (userOpts?.subject) {
      subject = {
        name: userOpts.subject,
      }
    } else {
      subject = helper.getSubject(confluentSchema, schemaInstance, separator)
    }

    try {
      const response = await this.api.Subject.config({ subject: subject.name })
      const { compatibilityLevel }: { compatibilityLevel: COMPATIBILITY } = response.data()

      if (compatibilityLevel.toUpperCase() !== compatibility) {
        throw new ConfluentSchemaRegistryCompatibilityError(
          `Compatibility does not match the configuration (${compatibility} != ${compatibilityLevel.toUpperCase()})`,
        )
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error
      }

      if (compatibility) {
        await this.api.Subject.updateConfig({ subject: subject.name, body: { compatibility } })
      }
    }

    const response = await this.api.Subject.register({
      subject: subject.name,
      body: {
        schemaType: confluentSchema.type,
        schema: confluentSchema.schema,
      },
    })

    const registeredSchema: RegisteredSchema = response.data()
    this.cache.setLatestRegistryId(subject.name, registeredSchema.id)
    this.cache.setSchema(registeredSchema.id, schemaInstance)

    return { id: registeredSchema.id, subject: subject.name }
  }

  public async getSubjects(): Promise<Array<string>> {
    const response = await this.api.Subject.all()
    return response.data<Array<string>>()
  }

  public async getSchemas(): Promise<Array<ExtendedAvroSchema>> {
    this.cache.clear()
    const response = await this.api.Schema.all()
    const foundSchemas: [ResponseSchema] = response.data()
    const result: Array<ExtendedAvroSchema> = []
    foundSchemas.forEach(foundSchema => result.push(this.convertSchema(foundSchema)))
    return result
  }

  public async getLatestSchema(subject: string): Promise<ExtendedAvroSchema> {
    const response = await this.api.Subject.latestVersion({ subject })
    return this.convertSchema(response.data())
  }

  public async getLatestSchemaId(subject: string): Promise<number> {
    const response = await this.api.Subject.latestVersion({ subject })
    const { id }: { id: number } = response.data()

    return id
  }

  public async getSchema(registryId: number): Promise<ExtendedAvroSchema> {
    const response = await this.api.Schema.find({ id: registryId })
    return this.convertSchema(response.data())
  }

  private convertSchema(foundSchema: ResponseSchema) {
    const rawSchema = foundSchema.schema
    const schemaType = schemaTypeFromString(foundSchema.schemaType)

    if (schemaType === SchemaType.UNKNOWN) {
      throw new ConfluentSchemaRegistryError(`Unknown schema type ${foundSchema.schemaType}`)
    }

    const confluentSchema: ConfluentSchema = {
      type: schemaType,
      schema: rawSchema,
    }
    const options = cloneDeep(this.options)
    const schemaInstance = schemaFromConfluentSchema(confluentSchema, options)
    return {
      id: foundSchema.id,
      version: foundSchema.version,
      subject: foundSchema.subject,
      schema: schemaInstance,
    } as ExtendedAvroSchema
  }

  public async encode(registryId: number, payload: any): Promise<Buffer> {
    if (!registryId) {
      throw new ConfluentSchemaRegistryArgumentError(
        `Invalid registryId: ${JSON.stringify(registryId)}`,
      )
    }

    const schema = await this.getSchema(registryId)
    try {
      const serializedPayload = schema.schema.toBuffer(payload)
      return encode(registryId, serializedPayload)
    } catch (error) {
      if (error instanceof ConfluentSchemaRegistryValidationError) throw error

      const paths = this.collectInvalidPaths(schema.schema, payload)
      throw new ConfluentSchemaRegistryValidationError(error, paths)
    }
  }

  private collectInvalidPaths(schema: Schema, jsonPayload: object) {
    const paths: string[][] = []
    schema.isValid(jsonPayload, {
      errorHook: path => paths.push(path),
    })

    return paths
  }

  public async decode(buffer: Buffer): Promise<any> {
    if (!Buffer.isBuffer(buffer)) {
      throw new ConfluentSchemaRegistryArgumentError('Invalid buffer')
    }

    const { magicByte, registryId, payload } = decode(buffer)
    if (Buffer.compare(MAGIC_BYTE, magicByte) !== 0) {
      throw new ConfluentSchemaRegistryArgumentError(
        `Message encoded with magic byte ${JSON.stringify(magicByte)}, expected ${JSON.stringify(
          MAGIC_BYTE,
        )}`,
      )
    }

    const schema = await this.getSchema(registryId)
    return schema.schema.fromBuffer(payload)
  }

  public async getRegistryId(subject: string, version: number | string): Promise<number> {
    const response = await this.api.Subject.version({ subject, version })
    const { id }: { id: number } = response.data()

    return id
  }

  public async getRegistryIdBySchema(
    subject: string,
    schema: AvroSchema | RawAvroSchema | ConfluentSchema,
  ): Promise<number> {
    try {
      const confluentSchema: ConfluentSchema = this.getConfluentSchema(schema)
      const response = await this.api.Subject.registered({
        subject,
        body: {
          schemaType: confluentSchema.type,
          schema: confluentSchema.schema,
        },
      })
      const { id }: { id: number } = response.data()

      return id
    } catch (error) {
      if (error.status && error.status === 404) {
        throw new ConfluentSchemaRegistryError(error)
      }

      throw error
    }
  }
}