"use client";

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
} from "@react-pdf/renderer";
import { GeneratedStory } from "@/types";
import { formatCalendarDate } from "@/lib/dates";

const styles = StyleSheet.create({
  page: {
    padding: 50,
    backgroundColor: "#FFFDF7",
    fontFamily: "Helvetica",
  },
  coverPage: {
    padding: 50,
    backgroundColor: "#667eea",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontFamily: "Helvetica",
  },
  coverTitle: {
    fontSize: 36,
    color: "white",
    textAlign: "center",
    fontFamily: "Helvetica-Bold",
    marginBottom: 16,
  },
  coverSubtitle: {
    fontSize: 16,
    color: "#c7d2fe",
    textAlign: "center",
    fontStyle: "italic",
  },
  coverDate: {
    fontSize: 12,
    color: "#c7d2fe",
    textAlign: "center",
    marginTop: 40,
  },
  chapterNumber: {
    fontSize: 10,
    color: "#6366f1",
    marginBottom: 4,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase" as const,
    letterSpacing: 2,
  },
  chapterTitle: {
    fontSize: 24,
    color: "#1e293b",
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  chapterDate: {
    fontSize: 11,
    color: "#94a3b8",
    marginBottom: 16,
  },
  narrative: {
    fontSize: 12,
    color: "#334155",
    lineHeight: 1.8,
    textAlign: "justify" as const,
  },
  image: {
    width: "100%",
    maxHeight: 220,
    objectFit: "cover" as const,
    borderRadius: 8,
    marginBottom: 16,
  },
  separator: {
    width: 60,
    height: 2,
    backgroundColor: "#e8dcc8",
    marginVertical: 20,
  },
  pageNumber: {
    position: "absolute",
    bottom: 30,
    right: 50,
    fontSize: 10,
    color: "#94a3b8",
  },
  leftBorder: {
    position: "absolute",
    left: 40,
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: "#e8b4b8",
    opacity: 0.4,
  },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 50,
    fontSize: 8,
    color: "#cbd5e1",
  },
});

interface PdfDocumentProps {
  story: GeneratedStory;
}

export default function PdfDocument({ story }: PdfDocumentProps) {
  return (
    <Document>
      {/* Cover page */}
      <Page size="A4" style={styles.coverPage}>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={styles.coverTitle}>{story.title}</Text>
          <Text style={styles.coverSubtitle}>{story.subtitle}</Text>
          <Text style={styles.coverDate}>
            Created on{" "}
            {new Date(story.generatedAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </Text>
        </View>
      </Page>

      {/* Story pages */}
      {story.pages.map((page) => (
        <Page key={page.pageNumber} size="A4" style={styles.page}>
          <View style={styles.leftBorder} />
          <View style={{ paddingLeft: 15 }}>
            <Text style={styles.chapterNumber}>
              Chapter {page.pageNumber}
            </Text>
            <Text style={styles.chapterTitle}>{page.title}</Text>
            <Text style={styles.chapterDate}>
              {formatCalendarDate(page.date)}
            </Text>
            <View style={styles.separator} />

            {page.imageUrl && (
              <Image src={page.imageUrl} style={styles.image} />
            )}

            <Text style={styles.narrative}>{page.narrative}</Text>
          </View>

          <Text style={styles.pageNumber}>{page.pageNumber + 1}</Text>
          <Text style={styles.footer}>MyLifeJourney</Text>
        </Page>
      ))}
    </Document>
  );
}
