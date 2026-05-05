# Winter Interactive Snow Text Web

Python OpenCV + MediaPipe 기반 “눈 텍스트가 피사체 위에 내리고 쌓이는 인터랙티브 시스템”을 정적 웹 프로젝트로 재설계한 버전입니다.

## 실행 방법

```bash
mkdir -p winter-interactive
cd winter-interactive
# 이 저장소/폴더 안에 snow-web 폴더를 둡니다.
cd snow-web
python3 -m http.server 8000
```

브라우저에서 아래 주소로 접속합니다.

```text
http://localhost:8000
```

그다음 `Start` 버튼을 누르고 카메라 권한을 허용하세요.

## 파일 구조

```text
winter-interactive/
└── snow-web/
    ├── index.html
    ├── style.css
    ├── main.js
    └── README.md
```

## 주요 파라미터 조절 위치

`main.js` 상단의 `CONFIG` 객체에서 조절합니다.

- `segmentationEveryNFrames`: segmentation 실행 빈도. 2~3 권장.
- `maskThreshold`: mask 판정 강도. 높을수록 피사체 영역이 엄격해집니다.
- `maskSampleStep`: outline/movement 샘플링 간격. 낮을수록 정밀하지만 무거워집니다.
- `maxFallingParticles`: falling snow 최대 개수.
- `snowFontSize`: “눈” 텍스트 크기.
- `minSpeed`, `maxSpeed`: 낙하 속도.
- `fallingAlpha`, `settledAlpha`: 떨어지는 눈/쌓인 눈 투명도.
- `glowBlur`: 텍스트 glow 강도.
- `maxStackPerCell`: 같은 위치에 쌓일 수 있는 최대량.
- `movementThreshold`: 움직임 감지 기준.
- `releaseRatio`: 움직임이 감지됐을 때 쌓인 눈이 떨어질 확률.

## 참고

카메라 API는 보안 정책상 `file://`에서 제한될 수 있습니다. `localhost` 로컬 서버에서 실행하는 방식을 권장합니다.

## 이번 수정 메모

- 피사체 전체 움직임이 감지되면 쌓여 있던 “눈” 일부가 다시 falling 상태로 전환됩니다.
- 손/팔처럼 국소적으로 크게 움직인 영역 주변의 쌓인 “눈”은 위/옆으로 튄 뒤 다시 낙하하도록 처리했습니다.
- 관련 값은 `main.js` 상단 `CONFIG`의 `RELEASE_*`, `SWEEP_*` 항목에서 조절할 수 있습니다.
