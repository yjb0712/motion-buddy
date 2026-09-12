export function PoseCanvas({ videoRef, demo }: { videoRef: React.RefObject<HTMLVideoElement>; demo: boolean }) {
  return <div className="camera-surface">
    <video ref={videoRef} className={demo ? 'camera-video hidden' : 'camera-video'} muted playsInline/>
    {demo && <div className="demo-camera" aria-label="次数演示画面">
      <span>DEMO</span>
      <b>本地次数演示</b>
      <small>真实训练时这里会显示摄像头画面</small>
    </div>}
  </div>
}
