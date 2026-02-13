import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import './Parallax.css'
import IDE from './pages/IDE.jsx'
import Pricing from './pages/Pricing.jsx'
import ShapesSlideshow from './components/ShapesSlideshow.jsx'

// Button styles (Uiverse.io by shah1345)
const buttonStyles = `
.button2 {
  display: inline-block;
  transition: all 0.2s ease-in;
  position: relative;
  overflow: hidden;
  z-index: 1;
  color: #090909;
  padding: 0.4em 1.7em;
  cursor: pointer;
  font-size: 18px;
  border-radius: 0.5em;
  background: #e8e8e8;
  border: 1px solid #e8e8e8;
}

.button2:active {
  color: #666;
}

.button2:before {
  content: "";
  position: absolute;
  left: 50%;
  transform: translateX(-50%) scaleY(1) scaleX(1.25);
  top: 100%;
  width: 140%;
  height: 180%;
  background-color: rgba(0, 0, 0, 0.05);
  border-radius: 50%;
  display: block;
  transition: all 0.5s 0.1s cubic-bezier(0.55, 0, 0.1, 1);
  z-index: -1;
}

.button2:after {
  content: "";
  position: absolute;
  left: 55%;
  transform: translateX(-50%) scaleY(1) scaleX(1.45);
  top: 180%;
  width: 160%;
  height: 190%;
  background-color: #646F82;
  border-radius: 50%;
  display: block;
  transition: all 0.5s 0.1s cubic-bezier(0.55, 0, 0.1, 1);
  z-index: -1;
}

.button2:hover {
  color: #ffffff;
  border: 1px solid #646F82;
}

.button2:hover:before {
  top: -35%;
  background-color: #646F82;
  transform: translateX(-50%) scaleY(1.3) scaleX(0.8);
}

.button2:hover:after {
  top: -45%;
  background-color: #646F82;
  transform: translateX(-50%) scaleY(1.3) scaleX(0.8);
}
`

const sections = [
  { id: 'overview', label: 'Insights' },
  { id: 'features', label: 'Solutions' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'how-it-works', label: 'How it works' },
]

// SVG transition paths (from codrops)
const paths = {
  step1: {
    unfilled: 'M 0 100 V 100 Q 50 100 100 100 V 100 z',
    inBetween: {
      curve1: 'M 0 100 V 50 Q 50 0 100 50 V 100 z',
      curve2: 'M 0 100 V 50 Q 50 100 100 50 V 100 z',
    },
    filled: 'M 0 100 V 0 Q 50 0 100 0 V 100 z',
  },
  step2: {
    filled: 'M 0 0 V 100 Q 50 100 100 100 V 0 z',
    inBetween: {
      curve1: 'M 0 0 V 50 Q 50 0 100 50 V 0 z',
      curve2: 'M 0 0 V 50 Q 50 100 100 50 V 0 z',
    },
    unfilled: 'M 0 0 V 0 Q 50 0 100 0 V 0 z',
  },
}

function App() {
  const [path, setPath] = useState(() => {
    if (typeof window === 'undefined') return '/'
    return window.location.pathname || '/'
  })
  const [showIDE, setShowIDE] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const overlayPathRef = useRef(null)

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger)

    // Lenis Initialization
    const lenis = new Lenis()
    lenis.on('scroll', ScrollTrigger.update)

    // Bind Lenis to GSAP ticker
    const tickerFunction = (time) => {
      lenis.raf(time * 1000)
    }
    gsap.ticker.add(tickerFunction)
    gsap.ticker.lagSmoothing(0)

    // Parallax Animation Logic
    const triggers = document.querySelectorAll('[data-parallax-layers]')
    triggers.forEach((triggerElement) => {
      let tl = gsap.timeline({
        scrollTrigger: {
          trigger: triggerElement,
          start: "0% 0%",
          end: "100% 0%",
          scrub: 0
        }
      });
      const layers = [
        { layer: "1", yPercent: 70 },
        { layer: "2", yPercent: 55 },
        { layer: "3", yPercent: 40 },
        { layer: "4", yPercent: 10 }
      ];
      layers.forEach((layerObj, idx) => {
        const target = triggerElement.querySelectorAll(`[data-parallax-layer="${layerObj.layer}"]`)
        if (target.length > 0) {
          tl.to(
            target,
            {
              yPercent: layerObj.yPercent,
              ease: "none"
            },
            idx === 0 ? undefined : "<"
          );
        }
      });
    })

    return () => {
      lenis.destroy()
      gsap.ticker.remove(tickerFunction)
      ScrollTrigger.getAll().forEach(t => t.kill())
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPop = () => {
      const newPath = window.location.pathname || '/'
      setPath(newPath)
      if (!newPath.startsWith('/ide')) {
        setShowIDE(false)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (to) => {
    if (typeof window === 'undefined') return
    const next = typeof to === 'string' ? to : '/'
    const current = window.location.pathname || '/'
    if (current === next) return
    window.history.pushState({}, '', next)
    setPath(next)
  }

  const isIDERoute = path.startsWith('/ide')
  const isPricingRoute = path.startsWith('/pricing')

  // Navbar reveal animations 
  const ease = [0.22, 1, 0.36, 1]
  const headerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.8, ease } },
  }
  const brandVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.8, ease } },
  }
  const navContainerVariants = {
    hidden: {},
    visible: {
      transition: { staggerChildren: 0.07, delayChildren: 0.05 },
    },
  }
  const navItemVariants = {
    hidden: { opacity: 0, y: -8, scale: 0.98 },
    visible: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: { duration: 0.45, ease },
    },
  }

  const handleNavClick = (id) => {
    if (typeof window === 'undefined') return
    if (id === 'pricing') {
      navigate('/pricing')
    }
  }

  // SVG path transition: reveal IDE
  const handleOpenIDE = () => {
    if (isAnimating) return
    setIsAnimating(true)

    const overlayPath = overlayPathRef.current
    if (!overlayPath) return

    gsap.timeline({
      onComplete: () => setIsAnimating(false),
    })
      .set(overlayPath, {
        attr: { d: paths.step1.unfilled },
      })
      .to(overlayPath, {
        duration: 0.8,
        ease: 'power4.in',
        attr: { d: paths.step1.inBetween.curve1 },
      }, 0)
      .to(overlayPath, {
        duration: 0.2,
        ease: 'power1',
        attr: { d: paths.step1.filled },
        onComplete: () => {
          setShowIDE(true)
          navigate('/ide')
        },
      })
      .set(overlayPath, {
        attr: { d: paths.step2.filled },
      })
      .to(overlayPath, {
        duration: 0.2,
        ease: 'sine.in',
        attr: { d: paths.step2.inBetween.curve1 },
      })
      .to(overlayPath, {
        duration: 1,
        ease: 'power4',
        attr: { d: paths.step2.unfilled },
      })
  }

  // SVG path transition: back to landing
  const handleBackToLanding = () => {
    if (isAnimating) return
    setIsAnimating(true)

    const overlayPath = overlayPathRef.current
    if (!overlayPath) return

    gsap.timeline({
      onComplete: () => setIsAnimating(false),
    })
      .set(overlayPath, {
        attr: { d: paths.step2.unfilled },
      })
      .to(overlayPath, {
        duration: 0.8,
        ease: 'power4.in',
        attr: { d: paths.step2.inBetween.curve2 },
      }, 0)
      .to(overlayPath, {
        duration: 0.2,
        ease: 'power1',
        attr: { d: paths.step2.filled },
        onComplete: () => {
          setShowIDE(false)
          navigate('/')
        },
      })
      .set(overlayPath, {
        attr: { d: paths.step1.filled },
      })
      .to(overlayPath, {
        duration: 0.2,
        ease: 'sine.in',
        attr: { d: paths.step1.inBetween.curve2 },
      })
      .to(overlayPath, {
        duration: 1,
        ease: 'power4',
        attr: { d: paths.step1.unfilled },
      })
  }

  return (
    <div className="relative min-h-screen font-sans antialiased text-white overflow-hidden">
      {/* SVG Overlay for page transition */}
      <svg
        className="overlay-svg"
        width="100%"
        height="100%"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          pointerEvents: 'none',
          width: '100%',
          height: '100%',
        }}
      >
        <path
          ref={overlayPathRef}
          vectorEffect="non-scaling-stroke"
          d="M 0 100 V 100 Q 50 100 100 100 V 100 z"
          fill="#000"
        />
      </svg>

      {/* IDE view - always rendered, hidden when not active so iframe pre-loads */}
      <div
        className="absolute inset-0 min-h-screen font-sans antialiased"
        style={{
          visibility: (isIDERoute || showIDE) ? 'visible' : 'hidden',
          pointerEvents: (isIDERoute || showIDE) ? 'auto' : 'none',
          zIndex: (isIDERoute || showIDE) ? 10 : -10,
        }}
      >
        <div className="relative z-10">
          <IDE />
          {/* Back button */}
          <button
            onClick={handleBackToLanding}
            className="fixed bottom-6 left-6 z-[100] px-5 py-2.5 rounded-full border border-black/20 bg-white/80 backdrop-blur-sm text-black text-sm font-medium hover:bg-black hover:text-white transition-all duration-300 shadow-lg"
          >
            ← Back
          </button>
        </div>
      </div>

      {isPricingRoute ? (
        <Pricing onNavigate={navigate} />
      ) : null}

      {/* Landing page - hidden when IDE is showing */}
      {!isIDERoute && !showIDE && !isPricingRoute && (
        <>
          {/* Background video */}
          <div className="fixed inset-[3px] -z-20 overflow-hidden rounded-[35px]">
            <video
              className="h-full w-full object-cover"
              src="/media/Homepage.mp4?v=6"
              playsInline
              muted
              autoPlay
              loop
              preload="auto"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-black/25 via-black/10 to-slate-900/30" />
          </div>

          {/* Border overlay */}
          <div className="fixed inset-[3px] z-50 pointer-events-none rounded-[35px] border-[4px] border-black" />

          {/* Page content */}
          <div className="relative z-10 flex min-h-screen flex-col">
            <motion.header
              className="mx-auto flex w-full items-center pl-0 pr-6 py-6"
              variants={headerVariants}
              initial="hidden"
              animate="visible"
            >
              <div className="flex flex-1 items-center ml-24">
                <motion.div
                  className="flex items-center gap-2"
                  variants={brandVariants}
                >
                  <img src="/logo.png" alt="Strata logo" className="h-16 w-16 object-contain" />
                  <span className="text-2xl font-semibold uppercase tracking-[0.22em] text-black">
                    Strata
                  </span>
                </motion.div>
              </div>

              <motion.nav
                className="hidden flex-1 items-center justify-center gap-10 text-lg text-black pr-20 md:flex"
                variants={navContainerVariants}
              >
                {sections.map((item) => (
                  <motion.button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    variants={navItemVariants}
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    className="relative inline-flex font-semibold tracking-wide transition-colors hover:text-black whitespace-nowrap after:absolute after:-bottom-1 after:left-0 after:h-[2px] after:w-0 after:bg-black after:content-[''] after:transition-all after:duration-300 hover:after:w-full"
                  >
                    {item.label}
                  </motion.button>
                ))}
              </motion.nav>

              <div className="flex-1" />
            </motion.header>

            <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-20 px-6 pb-16 pt-10">
              {/* Hero */}
              <section
                id="overview"
                className="flex flex-1 flex-col items-center justify-center text-center text-black"
              >
                {/* Slogan */}
                <motion.div
                  className="flex flex-col items-center"
                  initial={{ opacity: 0, y: -260, scale: 0.96 }}
                  animate={{
                    opacity: 1,
                    y: -260,
                    scale: 0.96,
                  }}
                  transition={{
                    opacity: { duration: 0.9, ease: 'easeOut' },
                    scale: { duration: 0.9, ease: 'easeOut' },
                  }}
                >
                  <h1 className="hero-heading max-w-3xl text-balance text-4xl tracking-tight sm:text-5xl lg:text-6xl">
                    Never Leave the window
                    <br className="hidden sm:block" />
                    Never leave the flow
                  </h1>
                </motion.div>

                {/* Open button (Independent) */}
                <motion.div
                  initial={{ opacity: 0, y: 0 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.9, delay: 0.2, ease: 'easeOut' }}
                >
                  <style>{buttonStyles}</style>
                  <button className="button2 mt-10" onClick={handleOpenIDE}>
                    Open
                  </button>
                </motion.div>
              </section>
            </main>

          </div>

          {/* Parallax Section from Osmo */}
          <div className="parallax-section">
            <div className="parallax">
              <section className="parallax__header">
                <div className="parallax__visuals">
                  <div className="parallax__black-line-overflow"></div>
                  <div data-parallax-layers className="parallax__layers">
                    <ShapesSlideshow />
                  </div>
                  <div className="parallax__fade"></div>
                </div>
              </section>

            </div>
          </div>
          {/* End Parallax Section */}



        </>
      )}
    </div>
  )
}

export default App
