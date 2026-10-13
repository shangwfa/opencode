/**
 * 媒体资源提取工具
 * 用于从文本和元数据中提取图片和视频 URL
 */

/**
 * 从文本中提取图片 URL
 * 支持 Markdown 格式: ![alt](url) 和 HTML 格式: <img src="url">
 */
export function extractImagesFromText(text: string): string[] {
  const imageUrls: string[] = []
  
  if (!text) return imageUrls
  
  // 提取 Markdown 格式的图片: ![alt](url)
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  let match
  while ((match = markdownImageRegex.exec(text)) !== null) {
    const url = match[2].trim()
    if (url && isValidUrl(url)) {
      imageUrls.push(url)
    }
  }
  
  // 提取 HTML 格式的图片: <img src="url">
  const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  while ((match = htmlImageRegex.exec(text)) !== null) {
    const url = match[1].trim()
    if (url && isValidUrl(url)) {
      imageUrls.push(url)
    }
  }
  
  // 去重
  return Array.from(new Set(imageUrls))
}

/**
 * 从文本中提取视频 URL
 * 支持 HTML 格式: <video src="url">
 */
export function extractVideosFromText(text: string): string[] {
  const videoUrls: string[] = []
  
  if (!text) return videoUrls
  
  // 提取 HTML 格式的视频: <video src="url">
  const htmlVideoRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi
  let match
  while ((match = htmlVideoRegex.exec(text)) !== null) {
    const url = match[1].trim()
    if (url && isValidUrl(url)) {
      videoUrls.push(url)
    }
  }
  
  // 去重
  return Array.from(new Set(videoUrls))
}

/**
 * 从元数据中提取媒体资源
 */
export function extractMediaFromMetadata(metadata: any): { images: string[]; videos: string[] } {
  const images: string[] = []
  const videos: string[] = []
  
  if (!metadata) {
    return { images, videos }
  }
  
  // 如果元数据中有预存储的媒体资源
  if (metadata.images && Array.isArray(metadata.images)) {
    metadata.images.forEach((url: string) => {
      if (isValidUrl(url)) {
        images.push(url)
      }
    })
  }
  
  if (metadata.videos && Array.isArray(metadata.videos)) {
    metadata.videos.forEach((url: string) => {
      if (isValidUrl(url)) {
        videos.push(url)
      }
    })
  }
  
  // 去重
  return {
    images: Array.from(new Set(images)),
    videos: Array.from(new Set(videos))
  }
}

/**
 * 从文本和元数据中提取所有媒体资源
 */
export function extractAllMedia(
  text: string,
  metadata?: any
): { images: string[]; videos: string[] } {
  const imagesFromText = extractImagesFromText(text)
  const videosFromText = extractVideosFromText(text)
  const mediaFromMetadata = extractMediaFromMetadata(metadata)
  
  // 合并并去重
  const allImages = Array.from(new Set([...imagesFromText, ...mediaFromMetadata.images]))
  const allVideos = Array.from(new Set([...videosFromText, ...mediaFromMetadata.videos]))
  
  return {
    images: allImages,
    videos: allVideos
  }
}

/**
 * 验证 URL 是否有效
 */
function isValidUrl(url: string): boolean {
  if (!url || url.trim().length === 0) {
    return false
  }
  
  try {
    // 尝试创建 URL 对象
    const urlObj = new URL(url)
    // 检查协议是否为 http、https 或 data
    return ['http:', 'https:', 'data:'].includes(urlObj.protocol)
  } catch {
    // 如果不是完整 URL，检查是否是相对路径（以 / 开头）
    // 或者检查是否是有效的路径格式
    return url.startsWith('/') || url.startsWith('./') || url.startsWith('../')
  }
}


