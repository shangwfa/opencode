import { WikiCollectionService } from './wiki-collection.service.js'
import { WikiCompilerService } from './wiki-compiler.service.js'
import { WikiSearchService } from './wiki-search.service.js'
import { WikiNavigateService } from './wiki-navigate.service.js'
import { WikiLintService } from './wiki-lint.service.js'
import { WikiRetrievalService } from './wiki-retrieval.service.js'

export const wikiCollectionService = new WikiCollectionService()
export const wikiCompilerService = new WikiCompilerService(wikiCollectionService)
export const wikiSearchService = new WikiSearchService(wikiCollectionService)
export const wikiNavigateService = new WikiNavigateService(wikiCollectionService)
export const wikiLintService = new WikiLintService()
export const wikiRetrievalService = new WikiRetrievalService(wikiSearchService, wikiCollectionService, wikiNavigateService)
