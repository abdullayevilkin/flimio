# Flimio — Audio + Loop Video → MP4

**Canlı:** https://abdullayevilkin.github.io/flimio/

Uzun audio (m4a, 10–20 dəq) və qısa video (mp4, ~10 san) götürür, videonu audionun sonuna qədər loop edir və MP4 kimi export edir. **Tam frontend-də işləyir**, server lazım deyil.

## Necə işləyir

- [Mediabunny](https://mediabunny.dev) ilə hər iki fayl brauzerdə demux olunur.
- **Re-encode yoxdur**: video və audio paketləri olduğu kimi (stream copy) yeni MP4-ə köçürülür, video paketlərinin timestamp-ləri hər loop üçün sürüşdürülür. 20 dəqiqəlik nəticə bir neçə saniyəyə hazır olur və keyfiyyət itkisi olmur.
- Son loop dəqiq audionun sonunda kəsilir (B-frame-lər nəzərə alınır).
- Chrome/Edge-də fayl **File System Access API** ilə birbaşa diskə yazılır (RAM-a yığılmır). Digər brauzerlərdə nəticə yaddaşda yığılır və "Yüklə" düyməsi ilə endirilir.

## İşə salmaq

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/
```

## Struktur

- `src/lib/loopMerge.ts` — əsas məntiq, framework-dən asılı deyil (başqa layihəyə kopyalana bilər)
- `src/App.tsx` — React UI (drag & drop, önizləmə, progress, ləğv etmə)

## Qeydlər

- Nəticə ölçüsü ≈ audio ölçüsü + video ölçüsü × loop sayı. Məs. 7 MB-lıq 1080p klip × 120 loop ≈ 900 MB. Ölçünü azaltmaq üçün klipi əvvəlcədən daha aşağı bitrate ilə hazırlayın.
- Klipin özünün audio track-i varsa nəzərə alınmır.
- Dəstəklənən codec-lər: video — H.264, HEVC, VP9, AV1; audio — AAC, MP3, Opus, FLAC.

## Deploy

`main`-ə hər push-da `.github/workflows/deploy.yml` layihəni build edib GitHub Pages-ə deploy edir.
