import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'
import { ImageZoom } from './chat-images'

/** 输入框里贴的一张图：先显示本地预览，存好后有 path；存失败的直接拿掉 */
export type PastedImage = { id: string; url: string; path?: string }

const MAX_IMAGES = 10

/**
 * 往对话输入框里贴图：剪贴板里有图就拦下这次粘贴，图一张张存到 Agent 那台电脑上（拿回路径），
 * 发送时把路径一起交给后台，后台照终端里粘贴截图的样子打进去。
 */
export function usePastedImages(upload?: (file: Blob) => Promise<string>) {
  const [images, setImages] = useState<PastedImage[]>([])
  // 本地预览用的 blob 地址：图拿掉后、离开时放掉
  const urls = useRef(new Set<string>())
  useEffect(() => {
    const kept = new Set(images.map((img) => img.url))
    for (const url of urls.current) {
      if (!kept.has(url)) {
        URL.revokeObjectURL(url)
        urls.current.delete(url)
      }
    }
  }, [images])
  useEffect(() => {
    const live = urls.current
    return () => live.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const drop = (id: string) =>
    setImages((list) => list.filter((img) => img.id !== id))

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith('image/')
    )
    if (!upload || !files.length) {
      return
    }
    e.preventDefault()
    const room = MAX_IMAGES - images.length
    if (files.length > room) {
      toast.error(tr('一次最多贴 {0} 张图', [String(MAX_IMAGES)]))
    }
    for (const file of files.slice(0, Math.max(room, 0))) {
      const id = crypto.randomUUID()
      const url = URL.createObjectURL(file)
      urls.current.add(url)
      setImages((list) => [...list, { id, url }])
      upload(file).then(
        (path) =>
          setImages((list) =>
            list.map((img) => (img.id === id ? { ...img, path } : img))
          ),
        (error: Error) => {
          drop(id)
          toast.error(tr('图没贴上：{0}', [error.message]))
        }
      )
    }
  }

  const paths = images.flatMap((img) => (img.path ? [img.path] : []))
  return {
    images,
    paths,
    uploading: images.some((img) => !img.path),
    onPaste,
    remove: drop,
    clear: () => setImages([]),
  }
}

/** 输入框上方一排贴进来的图，点开看大图，存好之前转圈，× 拿掉 */
export function PastedImages({
  images,
  onRemove,
}: {
  images: PastedImage[]
  onRemove: (id: string) => void
}) {
  return (
    <div className='flex flex-wrap gap-2 pt-1.5 pb-1'>
      {images.map((img) => (
        <div key={img.id} className='group relative size-14 shrink-0'>
          <ImageZoom src={img.url}>
            <button
              type='button'
              aria-label={tr('看大图')}
              className='block size-14 overflow-hidden rounded-lg border hover:opacity-90'
            >
              <img src={img.url} alt='' className='size-full object-cover' />
            </button>
          </ImageZoom>
          {!img.path && (
            <span className='pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-background/60'>
              <LoaderCircle className='size-4 animate-spin text-muted-foreground' />
            </span>
          )}
          <button
            type='button'
            onClick={() => onRemove(img.id)}
            aria-label={tr('拿掉这张图')}
            className='absolute -end-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-panel text-muted-foreground shadow-sm hover:text-foreground'
          >
            <X className='size-3' />
          </button>
        </div>
      ))}
    </div>
  )
}
