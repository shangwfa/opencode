import { documentService, vectorService } from '../../rag/knowledge-base/index.js'
import { DatabaseService } from './database.service'

export const databaseService = new DatabaseService(vectorService, documentService)
