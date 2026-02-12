import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import IDE from './pages/IDE.jsx'
import Pricing from './pages/Pricing.jsx'

const sections = [
  { id: 'overview', label: 'Insights' },
  { id: 'features', label: 'Solutions' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'how-it-works', label: 'How it works' },
]

function App() {
  const [path, setPath] = useState(() => {
    if (typeof window === 'undefined') return '/'
    return window.location.pathname || '/'
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPop = () => setPath(window.location.pathname || '/')
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

  return (
    <div className="relative min-h-screen font-sans antialiased text-white overflow-hidden">
      {isIDERoute ? (
        <div className="relative min-h-screen font-sans antialiased text-black">
          <div className="fixed inset-0 -z-20 overflow-hidden bg-white" />
          <div className="relative z-10">
            <IDE />
          </div>
        </div>
      ) : isPricingRoute ? (
        <Pricing onNavigate={navigate} />
      ) : (
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
                <motion.div
                  className="flex flex-col items-center"
                  initial={{ opacity: 0, y: -340, scale: 0.96 }}
                  animate={{
                    opacity: 1,
                    y: -340,
                    scale: 0.96,
                  }}
                  transition={{
                    opacity: { duration: 0.9, ease: 'easeOut' },
                    scale: { duration: 0.9, ease: 'easeOut' },
                  }}
                >
                  <h1 className="hero-heading max-w-3xl text-balance text-4xl tracking-tight sm:text-5xl lg:text-6xl">
                    Never Leave the window,
                    <br className="hidden sm:block" />
                    Never leave the flow
                  </h1>

                </motion.div>
              </section>
            </main>
          </div>
        </>
      )}
    </div>
  )
}

export default App
