export type ObjectStorageObject = {
  body: ReadableStream<Uint8Array>
}

export type ObjectStorage = {
  get(key: string): Promise<ObjectStorageObject | null>
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
}

export function createObjectStorage(bucket: R2Bucket): ObjectStorage {
  return {
    async get(key) {
      const object = await bucket.get(key)
      return object ? { body: object.body } : null
    },
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } })
    },
  }
}
