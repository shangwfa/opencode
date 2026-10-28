export class FileParser {
  /**
   * 解析 PDF 文件
   */
  static async parsePDF(buffer: Buffer): Promise<string> {
    try {
      // PDF 的原生依赖只在解析 PDF 时加载，不能阻止纯文档服务启动。
      const { PDFParse } = await import('pdf-parse')
      const pdfParse = new PDFParse({ data: buffer })
      const result = await pdfParse.getText()
      return result.text
    } catch (error: any) {
      throw new Error(`Failed to parse PDF: ${error.message}`)
    }
  }

  /**
   * 解析 DOCX 文件（已移除，不再支持）
   * @deprecated DOCX 解析功能已移除
   */
  static async parseDOCX(buffer: Buffer): Promise<string> {
    throw new Error('DOCX parsing is not supported. Please convert DOCX files to PDF or TXT format.')
  }

  /**
   * 解析 TXT 文件
   */
  static async parseTXT(buffer: Buffer): Promise<string> {
    return buffer.toString('utf-8')
  }

  /**
   * 解析 Markdown 文件
   */
  static async parseMarkdown(buffer: Buffer): Promise<string> {
    return buffer.toString('utf-8')
  }

  /**
   * 根据文件扩展名解析文件
   */
  static async parseFile(
    buffer: Buffer,
    filename: string
  ): Promise<{ content: string; type: 'text' | 'markdown' | 'html' }> {
    const ext = filename.toLowerCase().split('.').pop() || ''

    switch (ext) {
      case 'pdf':
        return {
          content: await this.parsePDF(buffer),
          type: 'text'
        }

      case 'docx':
      case 'doc':
        // DOCX 解析功能已移除，按文本处理或抛出错误
        throw new Error('DOCX parsing is not supported. Please convert DOCX files to PDF or TXT format.')

      case 'txt':
        return {
          content: await this.parseTXT(buffer),
          type: 'text'
        }

      case 'md':
      case 'markdown':
        return {
          content: await this.parseMarkdown(buffer),
          type: 'markdown'
        }

      case 'html':
      case 'htm':
        return {
          content: buffer.toString('utf-8'),
          type: 'html'
        }

      default:
        // 默认按文本处理
        return {
          content: buffer.toString('utf-8'),
          type: 'text'
        }
    }
  }

  /**
   * 从 URL 抓取内容
   */
  static async parseURL(url: string): Promise<{ content: string; type: 'text' | 'markdown' | 'html' }> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: AbortSignal.timeout(30000) // 30秒超时
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`)
      }

      const contentType = response.headers.get('content-type') || ''
      const html = await response.text()

      // 简单的 HTML 文本提取（可以后续优化）
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      return {
        content: text,
        type: contentType.includes('html') ? 'html' : 'text'
      }
    } catch (error: any) {
      throw new Error(`Failed to fetch URL: ${error.message}`)
    }
  }
}
