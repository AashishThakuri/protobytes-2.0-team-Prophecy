import React, { useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { Observer } from 'gsap/Observer';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './ShapesSlideshow.css';

gsap.registerPlugin(Observer, ScrollTrigger);

const slidesData = [
    {
        id: 1,
        // Image: Futuristic AI Abstract Network
        image: 'https://images.unsplash.com/photo-1558494949-ef526b0042a0?q=80&w=2574&to=format&fit=crop',
        title: 'Multiple Agents',
        desc: 'Simultaneous AI Task Execution'
    },
    {
        id: 2,
        // Image: Podcasting/Voice Studio (More specific)
        image: 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?q=80&w=2670&auto=format&fit=crop',
        title: 'Voice Room',
        desc: 'Seamless Audio Collaboration'
    },
    {
        id: 3,
        image: 'https://images.unsplash.com/photo-1542831371-29b0f74f9713?q=80&w=2670&auto=format&fit=crop',
        title: 'IDE Agent',
        desc: 'Intelligent Code Editing & Generation'
    },
    {
        id: 4,
        image: 'https://images.unsplash.com/photo-1619983081563-430f63602796?q=80&w=2574&auto=format&fit=crop',
        title: 'Music Player',
        desc: 'Integrated Music Workflow'
    },
];

export default function ShapesSlideshow() {
    const containerRef = useRef(null);
    const slidesRef = useRef([]);
    const [current, setCurrent] = useState(0);
    const isAnimating = useRef(false);
    const currentIndexRef = useRef(0);

    const config = {
        clipPath: {
            initial: 'circle(55% at 70% 50%)',
            final: 'circle(15% at 70% 50%)',
        },
    };

    useLayoutEffect(() => {
        currentIndexRef.current = current;
    }, [current]);

    useLayoutEffect(() => {
        const ctx = gsap.context(() => {
            // Init first slide
            const firstSlide = slidesRef.current[0];
            if (firstSlide) {
                const title = firstSlide.querySelector('.slide__title');
                const desc = firstSlide.querySelector('.slide__desc');
                gsap.set([title, desc], { opacity: 1, y: 0 });
            }

            const observer = Observer.create({
                target: window,
                type: "wheel,touch,pointer",
                onUp: (self) => {
                    if (isAnimating.current) return;
                    // IMPORTANT: If current > 0, we navigate back. The DEFAULT action is PREVENTED.
                    // This ensures we stay in slideshow until index 0.
                    if (currentIndexRef.current > 0) {
                        self.event.preventDefault();
                        navigate('prev');
                    }
                    // If current === 0, we do NOTHING. Default scroll UP (to landing page) happens.
                },
                onDown: (self) => {
                    if (isAnimating.current) return;
                    // If current < max, navigate forward. Prevent Default scroll.
                    if (currentIndexRef.current < slidesData.length - 1) {
                        self.event.preventDefault();
                        navigate('next');
                    }
                    // If current === max, do NOTHING. Default scroll DOWN happens.
                },
                tolerance: 10,
                preventDefault: false
            });
            observer.disable();

            ScrollTrigger.create({
                trigger: containerRef.current,
                start: "top center",
                end: "bottom center",
                onEnter: () => observer.enable(),
                onEnterBack: () => observer.enable(),
                onLeave: () => observer.disable(),
                onLeaveBack: () => observer.disable(),
            });
        }, containerRef);
        return () => ctx.revert();
    }, []);

    const navigate = (direction) => {
        const slidesTotal = slidesData.length;
        const currentIndex = currentIndexRef.current;
        let nextIndex;

        if (direction === 'next') {
            nextIndex = currentIndex < slidesTotal - 1 ? currentIndex + 1 : currentIndex;
        } else {
            nextIndex = currentIndex > 0 ? currentIndex - 1 : currentIndex;
        }

        if (nextIndex === currentIndex) return;

        isAnimating.current = true;

        const currentSlideEl = slidesRef.current[currentIndex];
        const upcomingSlideEl = slidesRef.current[nextIndex];

        const currentImgWrap = currentSlideEl.querySelector('.slide__img-wrap');
        const currentImg = currentSlideEl.querySelector('.slide__img');
        const currentTitle = currentSlideEl.querySelector('.slide__title');
        const currentDesc = currentSlideEl.querySelector('.slide__desc');

        const upcomingImgWrap = upcomingSlideEl.querySelector('.slide__img-wrap');
        const upcomingImg = upcomingSlideEl.querySelector('.slide__img');
        const upcomingTitle = upcomingSlideEl.querySelector('.slide__title');
        const upcomingDesc = upcomingSlideEl.querySelector('.slide__desc');

        gsap.set(upcomingSlideEl, { zIndex: 100 });
        gsap.set(currentSlideEl, { zIndex: 99 });

        gsap.set([upcomingTitle, upcomingDesc], { opacity: 0, y: '100%' });

        const tl = gsap.timeline({
            onStart: () => {
                upcomingSlideEl.classList.add('slide--current');
                upcomingSlideEl.style.opacity = 1;
            },
            onComplete: () => {
                isAnimating.current = false;
                currentSlideEl.classList.remove('slide--current');
                currentSlideEl.style.opacity = 0;
                currentSlideEl.style.zIndex = 0;
                upcomingSlideEl.style.zIndex = 10;
                setCurrent(nextIndex);
                currentIndexRef.current = nextIndex;
            },
        });

        tl.addLabel('start', 0)
            .to(currentTitle, { duration: 0.8, ease: 'power2.inOut', y: '-100%', opacity: 0 }, 'start')
            .to(currentDesc, { duration: 0.8, ease: 'power2.inOut', y: '-50%', opacity: 0 }, 'start+=0.1')

            .set(upcomingImgWrap, {
                y: direction === 'next' ? '100%' : '-100%',
                clipPath: config.clipPath.final,
            }, 'start')
            .set(upcomingImg, {
                y: direction === 'next' ? '-50%' : '50%',
            }, 'start')

            .to(currentImgWrap, {
                duration: 1,
                ease: 'power3.inOut',
                clipPath: config.clipPath.final,
                rotation: 0.001,
            }, 'start')
            .to(currentImgWrap, {
                duration: 1,
                ease: 'power2.inOut',
                y: direction === 'next' ? '-100%' : '100%',
                rotation: 0.001,
            }, 'start+=0.4')
            .to(currentImg, {
                duration: 1,
                ease: 'power2.inOut',
                y: direction === 'next' ? '50%' : '-50%',
            }, 'start+=0.4')

            .to(upcomingImgWrap, {
                duration: 1,
                ease: 'power2.inOut',
                y: '0%',
                rotation: 0.001,
            }, 'start+=0.4')
            .to(upcomingImg, {
                duration: 1,
                ease: 'power2.inOut',
                y: '0%',
            }, 'start+=0.4')
            .to(upcomingImgWrap, {
                duration: 1.5,
                ease: 'expo.inOut',
                clipPath: config.clipPath.initial,
            }, 'start+=0.8')

            .to(upcomingTitle, {
                duration: 1,
                ease: 'power3.out',
                y: '0%',
                opacity: 1
            }, 'start+=1')
            .to(upcomingDesc, {
                duration: 1,
                ease: 'power3.out',
                y: '0%',
                opacity: 0.8
            }, 'start+=1.2');
    };

    return (
        <div className="slideshow" ref={containerRef}>
            {slidesData.map((slide, index) => (
                <figure
                    key={slide.id}
                    className={`slide ${index === 0 ? 'slide--current' : ''}`}
                    ref={(el) => (slidesRef.current[index] = el)}
                    style={{
                        opacity: index === 0 ? 1 : 0,
                        zIndex: index === 0 ? 10 : 0
                    }}
                >
                    <div className="slide__img-wrap">
                        <div
                            className="slide__img"
                            style={{ backgroundImage: `url(${slide.image})` }}
                        ></div>
                    </div>
                    <figcaption className="slide__content">
                        <h2 className="slide__title">{slide.title}</h2>
                        <p className="slide__desc">{slide.desc}</p>
                    </figcaption>
                </figure>
            ))}
        </div>
    );
}
