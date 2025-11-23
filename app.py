#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import streamlit as st
import requests
import os
import zipfile
from pathlib import Path
from typing import Optional, Dict, Tuple
from google_play_scraper import app as gplay_app, search as gplay_search
from bs4 import BeautifulSoup
import time

st.set_page_config(
    page_title="محمل التطبيقات",
    page_icon="📱",
    layout="wide"
)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
}

DOWNLOADS_DIR = Path("downloads")
OBB_DIR = DOWNLOADS_DIR / "obb"
TIMEOUT = 30

def create_directories():
    DOWNLOADS_DIR.mkdir(exist_ok=True)
    OBB_DIR.mkdir(exist_ok=True, parents=True)

def sanitize_filename(filename: str, package_name: Optional[str] = None) -> str:
    invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\x00']
    cleaned = filename
    for char in invalid_chars:
        cleaned = cleaned.replace(char, '_')
    
    cleaned = '_'.join(cleaned.split())
    while '__' in cleaned:
        cleaned = cleaned.replace('__', '_')
    cleaned = cleaned.strip('_')
    
    if not cleaned or len(cleaned) < 1:
        if package_name:
            cleaned = package_name.replace('.', '_')
        else:
            cleaned = 'app'
    
    max_length = 100
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].rstrip('_')
    
    return cleaned

def search_app(query: str) -> Optional[Dict]:
    if '.' in query and ' ' not in query and not any(c in query for c in ['/', '\\', '?']):
        try:
            app_info = gplay_app(query, lang='ar', country='us')
            return app_info
        except:
            try:
                app_info = gplay_app(query, lang='en', country='us')
                return app_info
            except:
                return None
    
    search_strategies = [
        {'lang': 'ar', 'country': 'sa'},
        {'lang': 'ar', 'country': 'ae'},
        {'lang': 'ar', 'country': 'eg'},
        {'lang': 'ar', 'country': 'us'},
        {'lang': 'en', 'country': 'us'},
        {'lang': 'en', 'country': 'gb'},
    ]
    
    results = None
    for strategy in search_strategies:
        try:
            results = gplay_search(query, **strategy, n_hits=10)
            if results:
                break
        except:
            continue
    
    if not results:
        return None
    
    try:
        first_result = results[0]
        package_name = first_result['appId']
        
        try:
            app_info = gplay_app(package_name, lang='ar', country='sa')
        except:
            try:
                app_info = gplay_app(package_name, lang='ar', country='us')
            except:
                app_info = gplay_app(package_name, lang='en', country='us')
        
        return app_info
        
    except Exception as e:
        return None

def get_apkpure_download_link(package_name: str, prefer_xapk: bool = False) -> Optional[Tuple[str, str]]:
    try:
        urls_to_try = []
        
        if prefer_xapk:
            urls_to_try.extend([
                (f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest", 'xapk'),
                (f"https://d.apkpure.com/b/APK/{package_name}?version=latest", 'apk'),
            ])
        else:
            urls_to_try.extend([
                (f"https://d.apkpure.com/b/APK/{package_name}?version=latest", 'apk'),
                (f"https://d.apkpure.com/b/XAPK/{package_name}?version=latest", 'xapk'),
            ])
        
        for url, file_type in urls_to_try:
            try:
                response = requests.head(url, headers=HEADERS, timeout=10, allow_redirects=True)
                if response.status_code == 200:
                    return (response.url, file_type)
            except:
                continue
        
        return None
        
    except Exception as e:
        return None

def get_apkcombo_apk_link(package_name: str) -> Optional[str]:
    try:
        url = f"https://apkcombo.com/{package_name}/download/apk"
        
        response = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        download_button = soup.select_one('a.variant')
        if not download_button:
            download_button = soup.select_one('a[href*="download"]')
        
        if download_button:
            download_page = download_button.get('href')
            if download_page and isinstance(download_page, str):
                if not download_page.startswith('http'):
                    download_page = f"https://apkcombo.com{download_page}"
                
                response2 = requests.get(download_page, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
                soup2 = BeautifulSoup(response2.text, 'html.parser')
                
                direct_link = soup2.select_one('a#download-link')
                if direct_link:
                    final_url = direct_link.get('href')
                    if final_url and isinstance(final_url, str):
                        return final_url
        
        return None
        
    except Exception as e:
        return None

def download_file_with_progress(url: str, filename: str, progress_bar, status_text) -> bool:
    try:
        response = requests.get(url, headers=HEADERS, stream=True, timeout=TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        
        total_size = int(response.headers.get('content-length', 0))
        downloaded = 0
        
        with open(filename, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        progress = downloaded / total_size
                        progress_bar.progress(progress)
                        status_text.text(f"تم التحميل: {downloaded / (1024*1024):.1f} MB من {total_size / (1024*1024):.1f} MB")
        
        return True
        
    except Exception as e:
        if os.path.exists(filename):
            os.remove(filename)
        return False

def extract_obb_files(archive_path: str, package_name: str, status_text) -> bool:
    try:
        if not zipfile.is_zipfile(archive_path):
            return True
        
        status_text.text("فحص محتويات الأرشيف...")
        
        obb_target_dir = OBB_DIR / package_name
        obb_target_dir.mkdir(exist_ok=True, parents=True)
        
        with zipfile.ZipFile(archive_path, 'r') as zip_ref:
            all_files = zip_ref.namelist()
            
            obb_files = [f for f in all_files if f.endswith('.obb')]
            apk_files = [f for f in all_files if f.endswith('.apk') and not f.startswith('__')]
            
            if obb_files:
                status_text.text(f"استخراج {len(obb_files)} ملف OBB...")
                
                for obb_file in obb_files:
                    obb_filename = os.path.basename(obb_file)
                    target_path = obb_target_dir / obb_filename
                    
                    with zip_ref.open(obb_file) as source, open(target_path, 'wb') as target:
                        target.write(source.read())
            
            if apk_files:
                main_apk = apk_files[0]
                apk_target = DOWNLOADS_DIR / f"{package_name}_main.apk"
                
                status_text.text("استخراج APK الرئيسي...")
                
                with zip_ref.open(main_apk) as source, open(apk_target, 'wb') as target:
                    target.write(source.read())
        
        return True
        
    except Exception as e:
        return False

st.markdown("""
<style>
    .main {
        direction: rtl;
        text-align: right;
    }
    .stButton>button {
        width: 100%;
        background-color: #4CAF50;
        color: white;
        font-size: 18px;
        padding: 15px;
        border-radius: 10px;
    }
    .app-card {
        background-color: #f0f2f6;
        padding: 20px;
        border-radius: 10px;
        margin: 10px 0;
    }
</style>
""", unsafe_allow_html=True)

st.title("📱 محمل التطبيقات من Google Play")
st.markdown("### ابحث وحمّل أي تطبيق بصيغة APK أو XAPK")

create_directories()

col1, col2 = st.columns([3, 1])

with col1:
    query = st.text_input("🔍 ابحث عن التطبيق", placeholder="مثال: واتساب، تيك توك، ببجي، أو com.whatsapp")

with col2:
    format_type = st.selectbox("الصيغة", ["تلقائي", "APK", "XAPK"])

if st.button("🚀 بحث وتحميل"):
    if query:
        with st.spinner("جاري البحث عن التطبيق..."):
            app_info = search_app(query)
        
        if app_info:
            st.success(f"تم العثور على: {app_info['title']}")
            
            col1, col2 = st.columns(2)
            
            with col1:
                st.markdown(f"""
                <div class="app-card">
                    <h3>📦 {app_info['title']}</h3>
                    <p><strong>الحزمة:</strong> {app_info['appId']}</p>
                    <p><strong>الإصدار:</strong> {app_info.get('version', 'غير متوفر')}</p>
                    <p><strong>التقييم:</strong> ⭐ {app_info.get('score', 'N/A')}</p>
                    <p><strong>التحميلات:</strong> {app_info.get('installs', 'N/A')}</p>
                    <p><strong>الفئة:</strong> {app_info.get('genre', 'N/A')}</p>
                </div>
                """, unsafe_allow_html=True)
            
            with col2:
                if app_info.get('icon'):
                    st.image(app_info['icon'], width=200)
            
            st.markdown("---")
            st.subheader("جاري التحميل...")
            
            package_name = app_info['appId']
            app_name = sanitize_filename(app_info['title'], package_name)
            version = app_info.get('version', 'latest')
            
            is_game = 'game' in app_info.get('genre', '').lower() or 'ألعاب' in app_info.get('genre', '')
            prefer_xapk = is_game or format_type == "XAPK"
            
            download_url = None
            file_type = 'apk'
            
            status = st.empty()
            status.info("البحث عن رابط التحميل...")
            
            if not prefer_xapk:
                download_url = get_apkcombo_apk_link(package_name)
                if download_url:
                    file_type = 'apk'
            
            if not download_url:
                result = get_apkpure_download_link(package_name, prefer_xapk)
                if result:
                    download_url, file_type = result
            
            if download_url:
                filename = DOWNLOADS_DIR / f"{app_name}_v{version}.{file_type}"
                
                status.success(f"تم العثور على رابط التحميل! الصيغة: {file_type.upper()}")
                
                progress_bar = st.progress(0)
                status_text = st.empty()
                
                if download_file_with_progress(download_url, str(filename), progress_bar, status_text):
                    st.success(f"✅ تم التحميل بنجاح: {filename.name}")
                    
                    if file_type == 'xapk':
                        extract_status = st.empty()
                        extract_obb_files(str(filename), package_name, extract_status)
                        st.info(f"📁 ملفات OBB: {OBB_DIR / package_name}")
                    
                    with open(filename, 'rb') as f:
                        st.download_button(
                            label=f"📥 تنزيل {filename.name}",
                            data=f,
                            file_name=filename.name,
                            mime="application/vnd.android.package-archive"
                        )
                else:
                    st.error("❌ فشل التحميل. حاول مرة أخرى.")
            else:
                st.error("❌ لم يتم العثور على رابط تحميل")
                st.info(f"""
                يمكنك تحميل التطبيق يدوياً من:
                - [APKCombo](https://apkcombo.com/{package_name}/download)
                - [APKPure](https://apkpure.com/{package_name})
                """)
        else:
            st.error("❌ لم يتم العثور على التطبيق. تأكد من اسم التطبيق وحاول مرة أخرى.")
    else:
        st.warning("⚠️ الرجاء إدخال اسم التطبيق أولاً")

st.markdown("---")
st.markdown("""
<div style='text-align: center; color: #666;'>
    <p>📌 هذا التطبيق يبحث في Google Play Store ويحمل من مصادر APK الموثوقة</p>
    <p>✅ يدعم البحث بالعربية والإنجليزية</p>
    <p>✅ تحميل APK و XAPK</p>
    <p>✅ استخراج ملفات OBB تلقائياً</p>
</div>
""", unsafe_allow_html=True)

if os.path.exists(DOWNLOADS_DIR):
    files = list(DOWNLOADS_DIR.glob("*"))
    if files:
        with st.expander(f"📂 الملفات المحملة ({len(files)})"):
            for file in files:
                if file.is_file():
                    size_mb = file.stat().st_size / (1024 * 1024)
                    st.text(f"📄 {file.name} ({size_mb:.2f} MB)")
