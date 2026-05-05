from setuptools import setup, find_packages

setup(
    name='epec-deck-map',
    version='0.1.2',
    description='Custom deck.gl Dash component — direct layer construction, no @deck.gl/json',
    packages=find_packages(),
    package_data={'epec_deck_map': ['epec_deck_map.min.js']},
    install_requires=['dash>=2.0.0'],
    python_requires='>=3.9',
)
