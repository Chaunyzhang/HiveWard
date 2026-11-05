import type { ChatImage } from '@shared/api'
import { tr } from '@/lib/i18n'
import { scoped, useMachineId } from '@/lib/machine'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/** 对话里的图（老板贴的图、工具返回的截图）：缩略图一排，点开看大图 */
export function ChatImages({
  images,
  className,
}: {
  images: ChatImage[]
  className?: string
}) {
  const machine = useMachineId()
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {images.map((img) => {
        const src = scoped(`/api/chat-images/${img.id}`, machine)
        return (
          <ImageZoom key={img.id} src={src}>
            <button
              type='button'
              aria-label={tr('看大图')}
              className='overflow-hidden rounded-lg border bg-muted/40 hover:opacity-90'
            >
              <img
                src={src}
                alt=''
                loading='lazy'
                className='max-h-40 max-w-60 object-contain'
              />
            </button>
          </ImageZoom>
        )
      })}
    </div>
  )
}

/** 点 children 弹出这张图的大图 */
export function ImageZoom({
  src,
  children,
}: {
  src: string
  children: React.ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className='max-w-[min(92vw,1200px)] border-none bg-transparent p-0 shadow-none sm:max-w-[min(92vw,1200px)]'>
        <DialogTitle className='sr-only'>{tr('图片')}</DialogTitle>
        <img
          src={src}
          alt=''
          className='max-h-[85vh] w-full rounded-lg object-contain'
        />
      </DialogContent>
    </Dialog>
  )
}
