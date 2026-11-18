import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ShotFields } from '../shared/model'
import { ProjectStore } from './storage'

const shots: ShotFields[] = [
  { title: '雾港远眺', frames: 225, dialogue: '雾散之前，港口的灯不会熄灭。',
    prompt: '暮色中的旧港，远景固定机位。紫蓝色海面，灯塔微亮，远处山脉与码头形成剪影。手绘动画，16:9。', status: '已通过' },
  { title: '一封来信', frames: 240, dialogue: '信封上没有地址，只有一枚旧邮戳。',
    prompt: '桌面近景，暖光照在旧信封与封蜡上，一只袖口伸向画面中央。手绘动画，16:9。', status: '待审核' },
  { title: '塔灯亮起', frames: 210, dialogue: '塔灯划过海面，像有人在远处回应。',
    prompt: '低机位仰拍灯塔，光束扫过暮雾。保留紫蓝色调，以暖光强调灯窗。手绘动画，16:9。', status: '待制作' },
  { title: '潮声回响', frames: 225, dialogue: '天亮后，我们在码头见。',
    prompt: '黎明远景，码头小径通往灯塔，浅粉色天光倒映在水面。手绘动画，16:9。', status: '待制作' },
]

export function sampleTone(frequency: number, seconds = 1.15) {
  const rate = 48_000
  const samples = Math.round(rate * seconds)
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const time = i / rate
    const envelope = Math.min(1, time * 20, (seconds - time) * 10)
    wav.writeInt16LE(Math.round(Math.sin(time * frequency * Math.PI * 2) * envelope * 7000), 44 + i * 2)
  }
  return wav
}

export async function fillSample(store: ProjectStore, assets: string) {
  const temp = await mkdtemp(path.join(tmpdir(), 'manju-sample-'))
  try {
    await store.edit({ type: 'project.edit', title: store.snapshot.title, script: '雾港值守人收到一封旧信，沿码头走向灯塔。' })
    let project = await store.edit({ type: 'episode.add', title: '第 1 集 · 雾港来信' })
    const episodeId = project.episodes[0].id
    await store.edit({ type: 'episode.edit', episodeId, title: project.episodes[0].title, script: shots.map(shot => shot.dialogue).join('\n') })
    const image = (index: number) => path.join(assets, `0${index + 1}.jpg`)
    for (const [index, fields] of shots.entries()) {
      project = await store.edit({ type: 'shot.add', episodeId, title: fields.title })
      const shotId = project.episodes[0].shots.at(-1)!.id
      await store.edit({ type: 'shot.edit', episodeId, shotId, fields })
      await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'image' }, image(index))
      const audio = path.join(temp, `镜头 ${index + 1} 音调.wav`)
      await writeFile(audio, sampleTone(255 + index * 90))
      await store.importMedia({ scope: 'shot', episodeId, shotId, kind: 'audio' }, audio)
    }
    project = await store.edit({ type: 'reference.add', category: 'characters', title: '港口值守人' })
    await store.edit({ type: 'reference.edit', category: 'characters', referenceId: project.characters[0].id,
      title: '港口值守人', notes: '深紫色旧大衣，左袖有缝线。' })
    await store.importMedia({ scope: 'reference', category: 'characters', referenceId: project.characters[0].id }, image(1))
    project = await store.edit({ type: 'reference.add', category: 'scenes', title: '雾港灯塔' })
    await store.importMedia({ scope: 'reference', category: 'scenes', referenceId: project.scenes[0].id }, image(2))
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
  }
}
