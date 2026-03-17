# Login Promotional Video — Motion Graphics Abstrato

## Overview

Vídeo promocional de ~50 segundos renderizado com Remotion, exibido em loop ao lado do formulário de login. Visual abstrato e hipnótico que evoca "trading automatizado em ação". Sem texto — puro motion graphics. Loop seamless.

## Visual Direction

**Estilo:** Sutil e hipnótico. Movimentos lentos e fluidos. O visitante nem percebe onde o loop começa e termina.

**Paleta de cores:**
- Background: `#0a0a0a`
- Grid lines / pulsos de execução: `#06b6d4` (cyan) com glow (`box-shadow: 0 0 12px rgba(6,182,212,0.3)`)
- Candlesticks positivas: `#22c55e` (green)
- Candlesticks negativas: `#ef4444` (red)
- Números flutuantes: `#a1a1aa` (muted) com opacidade variável
- Partículas: `#27272a` base → `#06b6d4` highlight

## Composição Remotion

- **ID:** `LoginPromoVideo`
- **Resolução:** 1280x720 (16:9)
- **FPS:** 30
- **Duração:** 1500 frames (~50 segundos)
- **Output:** `public/login-promo.mp4`
- **Render command:** `npx remotion render remotion/index.ts LoginPromoVideo public/login-promo.mp4`
- **Script em package.json:** `"render:promo": "remotion render remotion/index.ts LoginPromoVideo public/login-promo.mp4"`

## Dados Pré-computados (`data.ts`)

Todos os elementos dependem de dados pré-definidos para garantir determinismo. Estrutura:

```ts
// Seed para geração determinística de partículas
export const PARTICLE_SEED = 42;

// 8 posições Y dos grid levels (em % da altura do vídeo, 15%–85%)
export const GRID_Y_POSITIONS: number[] = [15, 25, 35, 45, 55, 65, 75, 85];

// Caminho da linha de preço — waypoints (x,y) com interpolação linear entre pontos
// x: 0–1024 (80% de 1280), y: em % da altura (deve oscilar entre GRID_Y_POSITIONS)
// Espaçados ~50px horizontalmente. Total: ~20 waypoints ao longo de 1024px.
export const PRICE_PATH: Array<{ x: number; y: number }>;

// Candlesticks — posição e aparência pré-definidas
export const CANDLES: Array<{
  frame: number;    // frame de aparição (300–1100)
  x: number;        // posição x (alinhado ao PRICE_PATH)
  y: number;        // base da vela (em %)
  height: number;   // altura em px (20–60)
  isGreen: boolean; // true = alta (#22c55e), false = baixa (#ef4444)
}>;

// Pulsos — pré-calculados nos pontos onde PRICE_PATH cruza GRID_Y_POSITIONS
export const PULSES: Array<{
  frame: number;    // frame de disparo (450–1050)
  x: number;        // posição x do cruzamento
  y: number;        // posição y (= grid level cruzado)
  color: string;    // alternando '#06b6d4' e '#22c55e'
}>;

// Números flutuantes — aparecem próximos aos pulsos
export const FLOATING_NUMBERS: Array<{
  frame: number;    // frame de aparição (300–1200)
  x: number;        // posição x
  y: number;        // posição y inicial
  text: string;     // ex: "84,200.00", "+$145.20", "+0.8%"
}>;

// Partículas — posições e velocidades iniciais
export const PARTICLES: Array<{
  x: number;        // posição x inicial (0–1280)
  y: number;        // posição y inicial (0–720)
  vx: number;       // velocidade x (px/frame, muito baixa: -0.3 a 0.3)
  vy: number;       // velocidade y (px/frame, muito baixa: -0.3 a 0.3)
  size: number;     // tamanho (2–4px)
  isCyan: boolean;  // true = #06b6d4, false = #27272a
}>;
```

## Elementos Visuais (6 camadas)

Todas as camadas são sobrepostas com `AbsoluteFill`, de trás para frente:

### Camada 1: Partículas flutuantes (fundo)
- ~40 partículas definidas em `PARTICLES` com posição, velocidade e cor pré-computadas
- Posição calculada como: `initialPos + velocity * (frame % 1500)` — garante loop seamless automaticamente
- Partículas que saem da tela reaparecem do lado oposto (wrap modulo 1280/720)
- Conectadas por linhas SVG `<line>` quando distância < 100px (SVG permitido aqui por simplicidade)
- Opacidade base: 0.2–0.5, com brightening sutil (opacidade +0.2) quando próximas a um pulso de execução ativo (frames do pulso ± 15)
- Cor: maioria `#27272a`, ~20% `#06b6d4`
- Presente em toda a duração (frames 0–1500)

### Camada 2: Grid lines horizontais
- 8 linhas horizontais nas posições Y definidas em `GRID_Y_POSITIONS`
- Cor: `#06b6d4` com opacidade 0.15, glow: `box-shadow: 0 0 12px rgba(6,182,212,0.3)`
- Aparecem uma a uma com fade-in (frames 0–150, stagger de ~15 frames cada)
- Ficam visíveis até a dissolução (frames 1200–1500 fade-out)
- Largura: 80% da tela (1024px), centralizadas (offset x: 128px)

### Camada 3: Linha de preço contínua
- Interpolação linear entre waypoints definidos em `PRICE_PATH`
- Renderizada como segmentos `div` rotacionados entre waypoints consecutivos, revelados progressivamente
- Cor: `#fafafa` com opacidade 0.6, altura 2px
- Começa no frame 150, desenha até frame 1200 (~1024px em 1050 frames ≈ 0.97px/frame)
- Offset x: 128px (alinhado com grid lines)
- Na dissolução (1200–1500): opacidade faz fade-out para 0

### Camada 4: Candlesticks
- Definidos em `CANDLES` com posição, frame, altura e cor pré-computados
- Posicionados ao longo do `PRICE_PATH`, aparecendo atrás da "cabeça" da linha (x < progresso atual da linha)
- Corpo: retângulo `div` com width 10px, height variável, border-radius 2px
- Wick: `div` de 2px width centralizado, estendendo 8px acima e abaixo do corpo
- Animação de entrada: `spring()` no scaleY (0→1), duração ~20 frames
- ~70% green, ~30% red
- Opacidade: 0.4–0.7
- Na dissolução (1200–1500): fade-out para 0

### Camada 5: Pulsos de execução
- Definidos em `PULSES` com frame, posição e cor pré-computados (derivados dos cruzamentos de PRICE_PATH com GRID_Y_POSITIONS)
- Animação: circle `div` com border-radius 50%, scale 0→1 e opacidade 0.6→0 ao longo de 30 frames
- Raio máximo: 40px
- Cor alternando `#06b6d4` e `#22c55e`
- ~7 pulsos entre frames 450–1050

### Camada 6: Números flutuantes
- Definidos em `FLOATING_NUMBERS` com frame, posição e texto pré-computados
- Font: system monospace (`'Courier New', monospace`) — evita necessidade de font loading extra
- Tamanho: 12–14px
- Ciclo de vida: fade-in 0→0.4 (15 frames), visível 60 frames, fade-out 0.4→0 (15 frames) = 90 frames total
- Drift: translateY -20px ao longo dos 90 frames
- ~10 números entre frames 300–1200
- Textos exemplo: "84,200.00", "85,400.00", "+$145.20", "+$46.80", "+0.8%", "$12,450"

## Timeline

| Fase | Frames | Duração | Descrição |
|------|--------|---------|-----------|
| Emergência | 0–150 | 5s | Partículas fade-in, grid lines aparecem uma a uma |
| Linha de preço | 150–450 | 10s | Linha começa a ser desenhada, ondulando entre grids |
| Candlesticks | 300–750 | 15s | Velas surgem atrás da linha, primeiros números flutuam |
| Execuções | 450–1050 | 20s | Pulsos ao cruzar grids, mais números, partículas brilham momentaneamente perto dos pulsos |
| Pico | 1050–1200 | 5s | Máxima atividade — múltiplos pulsos, muitas velas, muitos números |
| Dissolução | 1200–1500 | 10s | Grid lines, linha de preço, velas, números fazem fade-out. Partículas permanecem (loop seamless) |

As fases se sobrepõem intencionalmente para transições orgânicas.

## Loop Seamless

- Frame 0 e frame 1500 devem ter o mesmo visual: fundo escuro com apenas partículas tênues
- Dissolução (1200–1500): todos os elementos exceto partículas fazem fade-out para opacidade 0
- Partículas usam `frame % 1500` para posição — loop automático e contínuo
- Partículas fazem wrap nas bordas da tela (modulo width/height)
- Na tag `<video>`: `autoPlay loop muted playsInline`

## Estrutura de Arquivos

```
remotion/
├── index.ts                    (já existe — sem alteração)
├── Root.tsx                    (já existe — adicionar LoginPromoVideo)
├── LoginPromoVideo.tsx         (composição principal — monta as 6 camadas)
├── styles.ts                   (já existe — reutilizar cores)
├── promo/
│   ├── Particles.tsx           (camada 1 — partículas + SVG lines)
│   ├── GridLines.tsx           (camada 2 — linhas horizontais)
│   ├── PriceLine.tsx           (camada 3 — segmentos div rotacionados)
│   ├── Candlesticks.tsx        (camada 4 — velas com spring)
│   ├── ExecutionPulses.tsx     (camada 5 — círculos expandindo)
│   ├── FloatingNumbers.tsx     (camada 6 — números com drift)
│   └── data.ts                 (todos os dados pré-computados)
```

## Integração na Página de Login

O vídeo renderizado (`public/login-promo.mp4`) substitui o `dashboard-demo.mp4` atual na página `/login`:
- Atualizar `src` do `<video>` de `/dashboard-demo.mp4` para `/login-promo.mp4`
- Remover `public/dashboard-demo.mp4`
- Layout side-by-side existente permanece (card à esquerda, vídeo à direita)

## Considerações Técnicas

- **Determinístico:** Todas as animações usam `useCurrentFrame()` + `interpolate()` com dados de `data.ts`. Nenhum `Math.random()` — usar seeded PRNG para gerar `PARTICLES` em `data.ts`.
- **SVG limitado:** SVG `<line>` permitido apenas para conexões entre partículas. Demais elementos usam `div` com CSS transforms.
- **Performance de render:** Elementos simples (divs com position absolute). ~40 partículas + O(n²) line checks é leve para Remotion.
- **Tamanho do arquivo:** ~50s de motion graphics em 720p estimado 3-6 MB.
- **Fallback mobile:** Vídeo oculto em telas < `lg` (comportamento existente).
