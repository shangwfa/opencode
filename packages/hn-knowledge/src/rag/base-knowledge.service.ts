import { BaseKnowledgeError } from './errors.js'
import type { BaseKnowledgeRepository } from './repository.js'
import type {
  BaseKnowledgeContentType,
  BaseKnowledgeDocument,
  CreateBaseKnowledgeDocumentRequest,
  UpdateBaseKnowledgeDocumentRequest
} from './types.js'
import { hashDocumentContent, serializeContent } from './utils.js'
import type { BaseKnowledgeVectorizationService } from './vectorization.service.js'

export class BaseKnowledgeService {
  constructor(
    private readonly repository: BaseKnowledgeRepository,
    private readonly vectorizationService: BaseKnowledgeVectorizationService
  ) {}

  async createDocument(
    knowledgeBaseId: string,
    request: CreateBaseKnowledgeDocumentRequest
  ): Promise<BaseKnowledgeDocument> {
    const content = serializeContent(request.content)
    const existing = await this.repository.getDocument(knowledgeBaseId, request.documentId)
    if (existing) {
      // 这里提前返回可以避免重复创建时产生一次无意义的 embedding 调用；事务内仍会再次校验并发竞争。
      throw new BaseKnowledgeError('Document already exists', 409, 'DOCUMENT_ALREADY_EXISTS')
    }

    const existingSpace = await this.repository.getSpace(knowledgeBaseId)
    const embeddingModel =
      existingSpace?.embeddingModel || (await this.repository.getEmbeddingModel(knowledgeBaseId))
    const vectorized = await this.vectorizationService.vectorize({
      documentId: request.documentId,
      content,
      type: request.type,
      embeddingModel
    })

    return this.repository.createDocument({
      knowledgeBaseId,
      documentId: request.documentId,
      content,
      normalizedContent: vectorized.normalizedContent,
      contentHash: hashDocumentContent(content, request.type),
      type: request.type,
      embeddingModel,
      embeddingDimension: vectorized.embeddingDimension,
      chunks: vectorized.chunks
    })
  }

  async updateDocument(
    knowledgeBaseId: string,
    documentId: string,
    request: UpdateBaseKnowledgeDocumentRequest
  ): Promise<BaseKnowledgeDocument> {
    const current = await this.repository.getDocument(knowledgeBaseId, documentId)
    if (!current) {
      throw new BaseKnowledgeError('Document not found', 404, 'DOCUMENT_NOT_FOUND')
    }

    const type = (request.type || current.type) as BaseKnowledgeContentType
    this.validateContentMatchesType(request.content, type)
    const content = serializeContent(request.content)
    const contentHash = hashDocumentContent(content, type)
    if (contentHash === current.contentHash) {
      // PUT 保持幂等：内容未变化时直接返回，避免重复向量化和版本递增。
      return current
    }

    const space = await this.repository.getSpace(knowledgeBaseId)
    if (!space) {
      throw new BaseKnowledgeError('Base knowledge not found', 404, 'BASE_KNOWLEDGE_NOT_FOUND')
    }
    const vectorized = await this.vectorizationService.vectorize({
      documentId,
      content,
      type,
      embeddingModel: space.embeddingModel
    })

    return this.repository.replaceDocument({
      knowledgeBaseId,
      documentId,
      content,
      normalizedContent: vectorized.normalizedContent,
      contentHash,
      type,
      expectedVersion: current.version,
      embeddingDimension: vectorized.embeddingDimension,
      chunks: vectorized.chunks
    })
  }

  async deleteDocument(knowledgeBaseId: string, documentId: string): Promise<void> {
    await this.repository.deleteDocument(knowledgeBaseId, documentId)
  }

  async deleteKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    await this.repository.deleteKnowledgeBase(knowledgeBaseId)
  }

  private validateContentMatchesType(
    content: string | Record<string, unknown>,
    type: BaseKnowledgeContentType
  ): void {
    if (type === 'tiptap' && (typeof content !== 'object' || content.type !== 'doc')) {
      throw new BaseKnowledgeError('Tiptap content must be a document object', 400, 'INVALID_CONTENT_TYPE')
    }
    if (type !== 'tiptap' && typeof content !== 'string') {
      throw new BaseKnowledgeError(`${type} content must be a string`, 400, 'INVALID_CONTENT_TYPE')
    }
  }
}
